import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "./version";

export const RESEARCH_RUN_JOB_TYPE = "pipeline" as const;
export const DEFAULT_RESEARCH_RUN_LEASE_MS = 5 * 60 * 1000;
export const WORKER_HEARTBEAT_STALE_MS = 30 * 1000;

export type ResearchRunJobStatus = "queued" | "running" | "completed" | "failed";

export interface ResearchRunJob {
  id: string;
  research_run_id: string;
  job_type: string;
  status: ResearchRunJobStatus;
  requested_by: string | null;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  result_json: Record<string, unknown> | null;
  failure_reason: string | null;
  queued_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface WorkerHealth {
  worker_id: string;
  status: string;
  last_seen_at: string | Date;
  started_at: string | Date;
  stopped_at: string | Date | null;
  metadata_json: Record<string, unknown>;
  stale: boolean;
}

export class ResearchRunQueueError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code = "RESEARCH_RUN_QUEUE_ERROR"
  ) {
    super(message);
    this.name = "ResearchRunQueueError";
  }
}

function database() {
  if (!process.env.DATABASE_URL) {
    throw new ResearchRunQueueError("DATABASE_URL is required", 500, "DATABASE_NOT_CONFIGURED");
  }
  return postgres(process.env.DATABASE_URL);
}

function asJob(row: Record<string, unknown> | undefined): ResearchRunJob | null {
  return row ? (row as unknown as ResearchRunJob) : null;
}

/** Enqueue one active pipeline job per run. Safe to call repeatedly. */
export async function enqueueResearchRun(
  runId: string,
  requestedBy = "user",
  options: { maxAttempts?: number } = {}
): Promise<ResearchRunJob> {
  const sql = database();
  try {
    const result = await sql.begin(async (tx) => {
      const runs = await tx`
        SELECT id, status, pipeline_version
        FROM research_runs
        WHERE id = ${runId}
        FOR UPDATE
      `;
      const run = runs[0];
      if (!run) {
        throw new ResearchRunQueueError("Research run not found", 404, "NOT_FOUND");
      }
      if (Number(run.pipeline_version) !== CURRENT_PIPELINE_VERSION) {
        throw new ResearchRunQueueError(
          `Only pipeline_version ${CURRENT_PIPELINE_VERSION} runs can be queued`,
          422,
          "UNSUPPORTED_PIPELINE_VERSION"
        );
      }
      if (["completed", "cancelled"].includes(String(run.status))) {
        throw new ResearchRunQueueError(
          `Run cannot be queued from status ${run.status}`,
          422,
          "INVALID_RUN_STATUS"
        );
      }

      const active = await tx`
        SELECT * FROM research_run_jobs
        WHERE research_run_id = ${runId}
          AND job_type = ${RESEARCH_RUN_JOB_TYPE}
          AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (active[0]) return active[0];

      const inserted = await tx`
        INSERT INTO research_run_jobs (
          id, research_run_id, job_type, status, requested_by, max_attempts,
          queued_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${runId}, ${RESEARCH_RUN_JOB_TYPE}, 'queued',
          ${requestedBy || "user"}, ${options.maxAttempts ?? 3}, NOW(), NOW(), NOW()
        )
        ON CONFLICT (research_run_id)
          WHERE job_type = 'pipeline' AND status IN ('queued', 'running')
        DO NOTHING
        RETURNING *
      `;
      if (inserted[0]) return inserted[0];

      // Another request won the partial unique-index race.
      const winner = await tx`
        SELECT * FROM research_run_jobs
        WHERE research_run_id = ${runId}
          AND job_type = ${RESEARCH_RUN_JOB_TYPE}
          AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (!winner[0]) {
        throw new ResearchRunQueueError("Unable to enqueue research run", 409, "QUEUE_RACE");
      }
      return winner[0];
    });
    return asJob(result as unknown as Record<string, unknown>)!;
  } finally {
    await sql.end();
  }
}

/** Claim one queued job atomically. Multiple workers are safe to call this concurrently. */
export async function claimNextResearchRun(
  leaseOwner: string,
  leaseMs = DEFAULT_RESEARCH_RUN_LEASE_MS
): Promise<ResearchRunJob | null> {
  const sql = database();
  try {
    const result = await sql.begin(async (tx) => {
      const jobs = await tx`
        SELECT * FROM research_run_jobs
        WHERE job_type = ${RESEARCH_RUN_JOB_TYPE}
          AND status = 'queued'
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY queued_at ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (!jobs[0]) return null;
      const claimed = await tx`
        UPDATE research_run_jobs
        SET status = 'running',
            lease_owner = ${leaseOwner},
            lease_expires_at = NOW() + ${leaseMs} * INTERVAL '1 millisecond',
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, NOW()),
            failure_reason = NULL,
            updated_at = NOW()
        WHERE id = ${jobs[0].id}
        RETURNING *
      `;
      return claimed[0] || null;
    });
    return asJob((result || undefined) as unknown as Record<string, unknown> | undefined);
  } finally {
    await sql.end();
  }
}

export async function renewResearchRunLease(
  jobId: string,
  leaseOwner: string,
  leaseMs = DEFAULT_RESEARCH_RUN_LEASE_MS
): Promise<ResearchRunJob | null> {
  const sql = database();
  try {
    const rows = await sql`
      UPDATE research_run_jobs
      SET lease_expires_at = NOW() + ${leaseMs} * INTERVAL '1 millisecond', updated_at = NOW()
      WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${leaseOwner}
      RETURNING *
    `;
    return asJob(rows[0] as unknown as Record<string, unknown> | undefined);
  } finally {
    await sql.end();
  }
}

export async function completeResearchRunJob(
  jobId: string,
  leaseOwner: string,
  result: Record<string, unknown>
): Promise<ResearchRunJob | null> {
  const sql = database();
  try {
    const rows = await sql`
      UPDATE research_run_jobs
      SET status = 'completed', result_json = ${sql.json(result as any)},
          lease_owner = NULL, lease_expires_at = NULL,
          completed_at = NOW(), updated_at = NOW()
      WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${leaseOwner}
      RETURNING *
    `;
    if (rows[0]) return asJob(rows[0] as unknown as Record<string, unknown>);
    const existing = await sql`SELECT * FROM research_run_jobs WHERE id = ${jobId} LIMIT 1`;
    return asJob(existing[0] as unknown as Record<string, unknown> | undefined);
  } finally {
    await sql.end();
  }
}

export async function failResearchRunJob(
  jobId: string,
  leaseOwner: string,
  failureReason: string
): Promise<ResearchRunJob | null> {
  const sql = database();
  try {
    const rows = await sql`
      UPDATE research_run_jobs
      SET status = 'failed', failure_reason = ${failureReason.slice(0, 4000)},
          lease_owner = NULL, lease_expires_at = NULL,
          completed_at = NOW(), updated_at = NOW()
      WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${leaseOwner}
      RETURNING *
    `;
    if (rows[0]) return asJob(rows[0] as unknown as Record<string, unknown>);
    const existing = await sql`SELECT * FROM research_run_jobs WHERE id = ${jobId} LIMIT 1`;
    return asJob(existing[0] as unknown as Record<string, unknown> | undefined);
  } finally {
    await sql.end();
  }
}

/** Requeue expired leases, or terminally fail jobs that exhausted attempts. */
export async function requeueExpiredResearchRunJobs(): Promise<ResearchRunJob[]> {
  const sql = database();
  try {
    const rows = await sql`
      WITH expired AS (
        SELECT id,
          CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END AS next_status
        FROM research_run_jobs
        WHERE job_type = ${RESEARCH_RUN_JOB_TYPE}
          AND status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < NOW()
        FOR UPDATE SKIP LOCKED
      )
      UPDATE research_run_jobs jobs
      SET status = expired.next_status,
          lease_owner = NULL,
          lease_expires_at = NULL,
          failure_reason = CASE WHEN expired.next_status = 'failed'
            THEN 'Lease expired after maximum attempts' ELSE 'Lease expired; job requeued' END,
          completed_at = CASE WHEN expired.next_status = 'failed' THEN NOW() ELSE NULL END,
          updated_at = NOW()
      FROM expired
      WHERE jobs.id = expired.id
      RETURNING jobs.*
    `;
    return rows as unknown as ResearchRunJob[];
  } finally {
    await sql.end();
  }
}

export async function getLatestResearchRunJob(runId: string): Promise<ResearchRunJob | null> {
  const sql = database();
  try {
    const rows = await sql`
      SELECT * FROM research_run_jobs
      WHERE research_run_id = ${runId} AND job_type = ${RESEARCH_RUN_JOB_TYPE}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return asJob(rows[0] as unknown as Record<string, unknown> | undefined);
  } finally {
    await sql.end();
  }
}

export async function listResearchRunJobs(runId: string): Promise<ResearchRunJob[]> {
  const sql = database();
  try {
    const rows = await sql`
      SELECT * FROM research_run_jobs
      WHERE research_run_id = ${runId} AND job_type = ${RESEARCH_RUN_JOB_TYPE}
      ORDER BY created_at DESC
    `;
    return rows as unknown as ResearchRunJob[];
  } finally {
    await sql.end();
  }
}

export async function recordWorkerHeartbeat(
  workerId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const sql = database();
  try {
    await sql`
      INSERT INTO research_worker_heartbeats
        (worker_id, status, last_seen_at, started_at, stopped_at, metadata_json, updated_at)
      VALUES (${workerId}, 'healthy', NOW(), NOW(), NULL, ${sql.json(metadata as any)}, NOW())
      ON CONFLICT (worker_id) DO UPDATE SET
        status = 'healthy', last_seen_at = NOW(), stopped_at = NULL,
        metadata_json = EXCLUDED.metadata_json, updated_at = NOW()
    `;
  } finally {
    await sql.end();
  }
}

export async function markWorkerStopped(workerId: string): Promise<void> {
  const sql = database();
  try {
    await sql`
      UPDATE research_worker_heartbeats
      SET status = 'stopped', stopped_at = NOW(), updated_at = NOW()
      WHERE worker_id = ${workerId}
    `;
  } finally {
    await sql.end();
  }
}

export async function getWorkerHealth(): Promise<WorkerHealth[]> {
  const sql = database();
  try {
    const rows = await sql`
      SELECT *, last_seen_at < NOW() - INTERVAL '30 seconds' AS stale
      FROM research_worker_heartbeats
      ORDER BY last_seen_at DESC
    `;
    return rows as unknown as WorkerHealth[];
  } finally {
    await sql.end();
  }
}

export async function hasHealthyResearchWorker(): Promise<boolean> {
  const sql = database();
  try {
    const rows = await sql`
      SELECT 1 FROM research_worker_heartbeats
      WHERE status = 'healthy' AND last_seen_at >= NOW() - INTERVAL '30 seconds'
      LIMIT 1
    `;
    return Boolean(rows[0]);
  } finally {
    await sql.end();
  }
}
