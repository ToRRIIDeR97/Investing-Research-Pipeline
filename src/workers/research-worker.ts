import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pipelineSql } from "@/db/pipeline-sql";
import { executeBacktestTask } from "@/lib/backtesting/executor";
import { runSystemResearchPipeline } from "@/lib/research/system-pipeline";
import { ResearchRunInterrupted, ResearchRunLocked } from "@/lib/research/pipeline-runner";
import {
  claimNextResearchRun,
  completeResearchRunJob,
  failResearchRunJob,
  markWorkerStopped,
  reconcileOrphanedResearchRuns,
  recordWorkerHeartbeat,
  releaseResearchRunJob,
  renewResearchRunLease,
  requeueExpiredResearchRunJobs,
  DEFAULT_RESEARCH_RUN_LEASE_MS,
} from "@/lib/research/run-queue";
import type { ResearchTask } from "@/lib/workflow/task-queue";
import { pollUntilStopped, withRetries } from "./poll-loop";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const once = process.argv.includes("--once");
const pollIntervalMs = Number(
  process.argv.find((arg) => arg.startsWith("--poll-interval-ms="))?.split("=")[1] || 5000
);
const workerId = process.argv.find((arg) => arg.startsWith("--worker-id="))?.split("=")[1]
  || `${hostname()}:${process.pid}`;

// Frequent renewal also lets a cancelled run, whose job loses its lease, stop within seconds.
const LEASE_RENEW_INTERVAL_MS = Math.max(1000, Math.min(10_000, Math.floor(DEFAULT_RESEARCH_RUN_LEASE_MS / 3)));

async function claimNextBacktestTask(): Promise<ResearchTask | null> {
  const sql = pipelineSql();
  const rows = await sql`
    UPDATE research_tasks
    SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
    WHERE id = (
      SELECT id FROM research_tasks
      WHERE status = 'pending' AND task_type = 'backtest'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, research_run_id, stage_id, task_key, task_type,
      agent_name, status, priority, input_json, output_json,
      validation_status, validation_result_json, retry_count, cost_usd,
      idempotency_key, started_at, completed_at, failure_reason,
      created_at, updated_at
  `;
  return (rows[0] as unknown as ResearchTask) || null;
}

/**
 * Claim and run one job. `runId` restricts the claim (tests). `signal` is the worker's shutdown signal: it aborts
 * the in-flight model call and puts the job back in the queue without using an attempt.
 */
export async function processNextResearchRunJob(options: { runId?: string; signal?: AbortSignal } = {}): Promise<boolean> {
  await requeueExpiredResearchRunJobs();
  await reconcileOrphanedResearchRuns({ runId: options.runId });
  const job = await claimNextResearchRun(workerId, undefined, { runId: options.runId });
  if (!job) return false;

  console.log(`claimed research run job ${job.id} for run ${job.research_run_id}`);
  // Aborts on shutdown, or once the lease is gone: taken over after expiry, or closed by a cancellation.
  const controller = new AbortController();
  const onShutdown = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onShutdown, { once: true });
  const renewInterval = setInterval(() => {
    void renewResearchRunLease(job.id, workerId).then((renewed) => {
      if (renewed || controller.signal.aborted) return;
      console.warn(`lost the lease on job ${job.id}; stopping run ${job.research_run_id}`);
      controller.abort();
    }, (error) => {
      console.error(`failed to renew lease for job ${job.id}:`, error);
    });
  }, LEASE_RENEW_INTERVAL_MS);

  let record: () => Promise<unknown>;
  let outcome: string;
  try {
    const result = await runSystemResearchPipeline(job.research_run_id, { signal: controller.signal });
    record = () => completeResearchRunJob(job.id, workerId, {
      ...result,
      worker_execution: "success",
      completed_at: new Date().toISOString(),
    });
    outcome = `completed research run job ${job.id} with workflow status ${result.status}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ResearchRunLocked) {
      // The run is still live in another worker: wait one lease instead of failing the job and using an attempt.
      record = () => releaseResearchRunJob(job.id, workerId, message, DEFAULT_RESEARCH_RUN_LEASE_MS);
      outcome = `deferred research run job ${job.id}: ${message}`;
    } else if (error instanceof ResearchRunInterrupted) {
      // A job this worker no longer owns (lost lease, cancelled run) is left as it is.
      record = () => releaseResearchRunJob(job.id, workerId, "Worker stopped during the run; job requeued");
      outcome = `stopped research run job ${job.id}`;
    } else {
      record = () => failResearchRunJob(job.id, workerId, message);
      outcome = `failed research run job ${job.id}: ${message}`;
    }
  } finally {
    clearInterval(renewInterval);
    options.signal?.removeEventListener("abort", onShutdown);
  }
  try {
    await withRetries(record);
    console.log(outcome);
  } catch (error) {
    console.error(`could not record "${outcome}"; the job is recovered when its lease expires:`, error);
  }
  return true;
}

async function processNextBacktestTask(): Promise<boolean> {
  const task = await claimNextBacktestTask();
  if (!task) return false;
  console.log(`claimed backtest task ${task.id}`);
  try {
    await executeBacktestTask(task);
    console.log(`completed backtest task ${task.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed backtest task ${task.id}: ${message}`);
  }
  return true;
}

export async function runResearchWorker() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for worker:research");
  const shutdown = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (shutdown.signal.aborted) {
      console.warn(`research-worker: second ${signal}; exiting now. An unfinished job is requeued when its lease expires.`);
      process.exit(130);
    }
    console.log(`research-worker: ${signal} received; aborting the current model call and requeueing its job`);
    shutdown.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await recordWorkerHeartbeat(workerId, { pid: process.pid, mode: once ? "once" : "poll" });
  const heartbeatInterval = setInterval(() => {
    void recordWorkerHeartbeat(workerId, { pid: process.pid, mode: once ? "once" : "poll" }).catch((error) => {
      console.error("failed to record worker heartbeat:", error);
    });
  }, 10_000);

  console.log(`research-worker ${workerId} started${once ? " in --once mode" : ""}`);
  try {
    await pollUntilStopped(async () => {
      const processedRun = await processNextResearchRunJob({ signal: shutdown.signal });
      return processedRun || shutdown.signal.aborted ? processedRun : processNextBacktestTask();
    }, { once, pollIntervalMs, signal: shutdown.signal });
  } finally {
    clearInterval(heartbeatInterval);
    await markWorkerStopped(workerId).catch((error) => console.error("failed to stop heartbeat:", error));
    console.log("research-worker stopped");
  }
}

if (require.main === module) {
  runResearchWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
