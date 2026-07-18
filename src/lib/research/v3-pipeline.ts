/**
 * Research OS v3 orchestrated runner.
 *
 * Explicitly separate from the v1/v2 monolith. The runner walks the v3
 * stage FSM in order, executes the registered bounded handler for each
 * stage, persists handler validation, and delegates stage advancement to
 * the deterministic workflow orchestrator. It never approves human gates,
 * never silently skips stages, and fails closed when a stage has no
 * registered handler.
 */

import postgres from "postgres";
import {
  advanceStage,
  startRun,
  failRun,
  pauseForHumanReview,
  getRunProgress,
} from "@/lib/workflow/orchestrator";
import { getStageConfig } from "@/lib/workflow/stages";
import { loadV3RunContext, type V3RunContext } from "./v3-context";
import { getV3StageHandler } from "./v3-stage-registry";
import { registerCoreV3Handlers } from "./v3/handlers";

export interface SystemPipelineResult {
  runId: string;
  status: string;
  completedStages: number;
  totalStages: number;
  notes: string[];
}

type StageRow = {
  id: string;
  stage_key: string;
  stage_order: number;
  status: string;
  max_retries: number | null;
  validation_result_json: unknown;
};

const MAX_ITERATIONS = 96;

function retryCountOf(stage: StageRow): number {
  const json = typeof stage.validation_result_json === "string"
    ? JSON.parse(stage.validation_result_json)
    : (stage.validation_result_json as Record<string, unknown> | null);
  return Number(json?.retryCount ?? 0);
}

async function getStages(sql: ReturnType<typeof postgres>, runId: string): Promise<StageRow[]> {
  return sql<StageRow[]>`
    SELECT id, stage_key, stage_order, status, max_retries, validation_result_json
    FROM research_stages
    WHERE research_run_id = ${runId}
    ORDER BY stage_order ASC
  `;
}

async function getRunStatus(sql: ReturnType<typeof postgres>, runId: string): Promise<string> {
  const rows = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
  if (!rows[0]) throw new Error(`Research run not found: ${runId}`);
  return String(rows[0].status);
}

async function markV3PipelineFailure(sql: ReturnType<typeof postgres>, runId: string, error: unknown): Promise<void> {
  console.error("V3 Pipeline failure error stack:", error);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE research_tasks
      SET status = 'failed', failure_reason = ${message}, completed_at = NOW(), updated_at = NOW()
      WHERE research_run_id = ${runId} AND status = 'running'
    `;
    await tx`
      UPDATE research_stages
      SET status = 'failed', failure_reason = ${message}, completed_at = NOW(), updated_at = NOW()
      WHERE research_run_id = ${runId} AND status IN ('running', 'waiting_for_human')
    `;
    await tx`
      UPDATE research_runs
      SET status = 'needs_more_work',
          failure_reason = ${message},
          completed_at = NOW(),
          metadata_json = (
            CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END
          ) || ${tx.unsafe(`'${JSON.stringify({
            v3_pipeline_failure: message,
            v3_pipeline_failed_at: new Date().toISOString(),
          }).replace(/'/g, "''")}'::jsonb`)},
          updated_at = NOW()
      WHERE id = ${runId}
    `;
  });
}

async function finalizeIfComplete(sql: ReturnType<typeof postgres>, runId: string): Promise<boolean> {
  const open = await sql`
    SELECT COUNT(*) AS cnt FROM research_stages
    WHERE research_run_id = ${runId}
      AND status IN ('pending', 'running', 'waiting_for_human')
  `;
  return Number(open[0].cnt) === 0;
}

async function result(sql: ReturnType<typeof postgres>, runId: string, notes: string[]): Promise<SystemPipelineResult> {
  const rows = await sql`
    SELECT rr.status,
           count(rs.*) FILTER (WHERE rs.status = 'completed') AS completed,
           count(rs.*) AS total
    FROM research_runs rr
    JOIN research_stages rs ON rs.research_run_id = rr.id
    WHERE rr.id = ${runId}
    GROUP BY rr.status
  `;
  return {
    runId,
    status: String(rows[0]?.status || "unknown"),
    completedStages: Number(rows[0]?.completed || 0),
    totalStages: Number(rows[0]?.total || 0),
    notes,
  };
}

/**
 * Execute (or resume) a pipeline_version = 3 research run.
 */
export async function runResearchPipelineV3(runId: string): Promise<SystemPipelineResult> {
  registerCoreV3Handlers();
  const sql = postgres(process.env.DATABASE_URL!);
  const notes: string[] = [];

  try {
    const versionRows = await sql`
      SELECT pipeline_version, status FROM research_runs WHERE id = ${runId}
    `;
    if (!versionRows[0]) throw new Error(`Research run not found: ${runId}`);
    if (Number(versionRows[0].pipeline_version || 1) < 3) {
      throw new Error(`Run ${runId} is not a v3 run (pipeline_version=${versionRows[0].pipeline_version})`);
    }

    if (String(versionRows[0].status) === "pending") {
      await startRun(runId);
      notes.push("Started v3 run");
    }

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const runStatus = await getRunStatus(sql, runId);
      if (runStatus === "waiting_for_human") {
        notes.push("Run is waiting for a human gate");
        return await result(sql, runId, notes);
      }
      if (["completed", "failed", "needs_more_work", "cancelled"].includes(runStatus)) {
        return await result(sql, runId, notes);
      }

      const stages = await getStages(sql, runId);
      const waiting = stages.find((stage) => stage.status === "waiting_for_human");
      if (waiting) {
        notes.push(`Stage ${waiting.stage_key} is waiting for human approval`);
        return await result(sql, runId, notes);
      }

      let active = stages.find((stage) => stage.status === "running");
      if (!active) {
        const next = stages.find((stage) => stage.status === "pending");
        if (!next) {
          const failed = stages.filter((stage) => stage.status === "failed");
          if (failed.length === 0) {
            const done = await finalizeIfComplete(sql, runId);
            if (done) return await result(sql, runId, notes);
            return await result(sql, runId, notes);
          }
          // Resume the earliest failed stage; reset everything after it.
          const target = failed[0];
          await sql.begin(async (tx) => {
            await tx`
              UPDATE research_stages
              SET status = 'running', failure_reason = NULL, completed_at = NULL,
                  started_at = NOW(), validation_result_json = NULL, updated_at = NOW()
              WHERE id = ${target.id}
            `;
            await tx`
              UPDATE research_stages
              SET status = 'pending', failure_reason = NULL, completed_at = NULL,
                  started_at = NULL, validation_result_json = NULL, updated_at = NOW()
              WHERE research_run_id = ${runId}
                AND stage_order > ${target.stage_order}
                AND status IN ('failed', 'cancelled', 'skipped')
                AND stage_key != ${target.stage_key}
            `;
            await tx`
              UPDATE research_runs
              SET status = 'running', failure_reason = NULL, completed_at = NULL, updated_at = NOW()
              WHERE id = ${runId} AND status IN ('needs_more_work', 'waiting_for_human', 'running')
            `;
          });
          notes.push(`Resuming failed stage ${target.stage_key}`);
          continue;
        }

        const config = getStageConfig(next.stage_key, 3);
        if (config?.requiresHumanApproval) {
          await sql.begin(async (tx) => [
            await tx`
              UPDATE research_stages
              SET status = 'waiting_for_human', started_at = NOW(), updated_at = NOW()
              WHERE id = ${next.id}
            `,
            await tx`
              UPDATE research_runs SET status = 'waiting_for_human', updated_at = NOW()
              WHERE id = ${runId}
            `,
          ]);
          notes.push(`Stage ${next.stage_key} requires human approval`);
          return await result(sql, runId, notes);
        }
        await sql`
          UPDATE research_stages
          SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
          WHERE id = ${next.id}
        `;
        active = { ...next, status: "running" };
      }

      const handler = getV3StageHandler(active.stage_key);
      if (!handler) {
        const message = `No v3 stage handler registered for stage "${active.stage_key}"; failing closed`;
        await markV3PipelineFailure(sql, runId, new Error(message));
        notes.push(message);
        return await result(sql, runId, notes);
      }

      let ctx: V3RunContext;
      try {
        ctx = await loadV3RunContext(sql, runId);
        const output = await handler.execute(ctx);
        const handlerValidation = await handler.validate(ctx, output);

        if (!handlerValidation.valid) {
          const retryCount = retryCountOf(active);
          const maxRetries = Number(active.max_retries ?? 2);
          if (retryCount < maxRetries) {
            await sql`
              UPDATE research_stages
              SET validation_result_json = ${sql.unsafe(`'${JSON.stringify({ ...handlerValidation, retryCount: retryCount + 1, handler: handler.stageKey }).replace(/'/g, "''")}'::jsonb`)},
                  updated_at = NOW()
              WHERE id = ${active.id}
            `;
            notes.push(`Stage ${active.stage_key} handler validation failed (retry ${retryCount + 1}/${maxRetries})`);
            continue;
          }

          const config = getStageConfig(active.stage_key, 3);
          const failureState = config?.failureState || "fail_run";
          const reason = `Stage "${active.stage_key}" handler validation failed after ${maxRetries} retries: ${handlerValidation.errors.join("; ")}`;
          if (failureState === "fail_run") {
            await failRun(runId, reason);
          } else if (failureState === "pause_for_human") {
            await pauseForHumanReview(runId, reason);
          } else {
            await sql`
              UPDATE research_stages
              SET status = 'failed', failure_reason = ${reason},
                  validation_result_json = ${sql.unsafe(`'${JSON.stringify(handlerValidation).replace(/'/g, "''")}'::jsonb`)},
                  completed_at = NOW(), updated_at = NOW()
              WHERE id = ${active.id}
            `;
            const remaining = await sql`
              UPDATE research_stages
              SET status = 'running', started_at = NOW(), updated_at = NOW()
              WHERE id = (
                SELECT id FROM research_stages
                WHERE research_run_id = ${runId} AND status = 'pending'
                ORDER BY stage_order ASC LIMIT 1
              )
              RETURNING stage_key
            `;
            if (remaining.length === 0) {
              await failRun(runId, reason);
            }
          }
          notes.push(reason);
          continue;
        }
      } catch (error) {
        await markV3PipelineFailure(sql, runId, error);
        notes.push(`Stage ${active.stage_key} execution failed: ${error instanceof Error ? error.message : String(error)}`);
        return await result(sql, runId, notes);
      }

      const advance = await advanceStage(runId);
      if (!advance.success && advance.action !== "retry") {
        notes.push(`Stage ${active.stage_key} could not advance: ${advance.error || advance.action}`);
        return await result(sql, runId, notes);
      }
      if (advance.action === "retry") {
        notes.push(`Stage ${active.stage_key} validation requested retry`);
        continue;
      }
      notes.push(`Completed stage ${active.stage_key}`);
    }

    throw new Error(`V3 pipeline exceeded ${MAX_ITERATIONS} stage iterations for run ${runId}`);
  } catch (error) {
    const status = await getRunStatus(sql, runId).catch(() => "unknown");
    if (!["completed", "failed", "needs_more_work", "waiting_for_human", "cancelled"].includes(status)) {
      await markV3PipelineFailure(sql, runId, error);
    }
    notes.push(error instanceof Error ? error.message : String(error));
    return await result(sql, runId, notes);
  } finally {
    await sql.end();
  }
}

export { getRunProgress };
