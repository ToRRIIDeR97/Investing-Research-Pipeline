/**
 * Research OS orchestrated runner.
 *
 * Walks the stage FSM in order, executes the registered bounded handler for each
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
import { getStageConfig, shouldSkipOptionalBacktest } from "@/lib/workflow/stages";
import { loadRunContext, type ResearchRunContext } from "./run-context";
import { getStageHandler } from "./stage-registry";
import { registerCoreHandlers } from "./handlers";
import { CURRENT_PIPELINE_VERSION } from "./version";

export interface SystemPipelineResult {
  runId: string;
  status: string;
  completedStages: number;
  totalStages: number;
  notes: string[];
  failure_reason?: string | null;
}

type StageRow = {
  id: string;
  stage_key: string;
  stage_order: number;
  status: string;
  failure_reason: string | null;
  max_retries: number | null;
  validation_result_json: unknown;
};

async function settleStageArtifacts(
  sql: ReturnType<typeof postgres>,
  runId: string,
  stageId: string,
  status: "validated" | "rejected"
) {
  // Handlers may persist an artifact before their final validator runs. Keep
  // that write invisible until validation succeeds; rejected attempts remain
  // auditable without becoming downstream inputs.
  await sql`
    UPDATE research_artifacts
    SET status = ${status}, updated_at = NOW()
    WHERE research_run_id = ${runId}
      AND status IN ('draft', 'validated')
      AND updated_at >= COALESCE(
        (SELECT started_at FROM research_stages WHERE id = ${stageId}),
        NOW()
      )
  `;
}

async function stageInvalidTasks(
  sql: ReturnType<typeof postgres>,
  runId: string,
  stageId: string,
  errors: string[]
) {
  const tasks = await sql`
    SELECT id, agent_name, task_type, output_json
    FROM research_tasks
    WHERE research_run_id = ${runId} AND stage_id = ${stageId} AND status = 'completed'
  `;
  for (const task of tasks) {
    await sql`
      INSERT INTO agent_output_staging (
        research_run_id, stage_id, task_id, target_table,
        output_schema_key, output_schema_version, payload_json,
        validation_status, validation_errors_json, review_status,
        created_by_agent, rejected_at, rejection_reason
      ) VALUES (
        ${runId}, ${stageId}, ${task.id}, 'research_tasks',
        ${task.task_type}, 4, ${sql.json(task.output_json || {})},
        'invalid', ${sql.json(errors)}, 'rejected', ${task.agent_name || 'research-os'},
        NOW(), ${errors.join('; ').slice(0, 4000)}
      )
    `;
  }
}

const MAX_ITERATIONS = 96;

function retryCountOf(stage: StageRow): number {
  const json = typeof stage.validation_result_json === "string"
    ? JSON.parse(stage.validation_result_json)
    : (stage.validation_result_json as Record<string, unknown> | null);
  return Number(json?.retryCount ?? 0);
}

async function getStages(sql: ReturnType<typeof postgres>, runId: string): Promise<StageRow[]> {
  return sql<StageRow[]>`
    SELECT id, stage_key, stage_order, status, failure_reason, max_retries, validation_result_json
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

async function markPipelineFailure(sql: ReturnType<typeof postgres>, runId: string, error: unknown): Promise<void> {
  console.error("V4 Pipeline failure error stack:", error);
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
           rr.failure_reason,
           count(rs.*) FILTER (WHERE rs.status = 'completed') AS completed,
           count(rs.*) AS total
    FROM research_runs rr
    JOIN research_stages rs ON rs.research_run_id = rr.id
    WHERE rr.id = ${runId}
    GROUP BY rr.status, rr.failure_reason
  `;
  return {
    runId,
    status: String(rows[0]?.status || "unknown"),
    completedStages: Number(rows[0]?.completed || 0),
    totalStages: Number(rows[0]?.total || 0),
    notes,
    failure_reason: rows[0]?.failure_reason ? String(rows[0].failure_reason) : null,
  };
}

/**
 * Execute (or resume) a current-version research run.
 */
export async function runResearchPipeline(runId: string): Promise<SystemPipelineResult> {
  registerCoreHandlers();
  const sql = postgres(process.env.DATABASE_URL!);
  const notes: string[] = [];

  try {
    const versionRows = await sql`
      SELECT pipeline_version, status FROM research_runs WHERE id = ${runId}
    `;
    if (!versionRows[0]) throw new Error(`Research run not found: ${runId}`);
    if (Number(versionRows[0].pipeline_version || 1) !== CURRENT_PIPELINE_VERSION) {
      throw new Error(`Run ${runId} is not a current v4 run (pipeline_version=${versionRows[0].pipeline_version})`);
    }

    if (String(versionRows[0].status) === "pending") {
      await startRun(runId);
      notes.push("Started v4 run");
    }

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const runStatus = await getRunStatus(sql, runId);
      if (runStatus === "waiting_for_human") {
        notes.push("Run is waiting for a human gate");
        return await result(sql, runId, notes);
      }
      if (runStatus === "needs_more_work") {
        if (iteration > 0) return await result(sql, runId, notes);
        const failedStage = (await getStages(sql, runId)).find((stage) => stage.status === "failed");
        if (!failedStage) return await result(sql, runId, notes);
        await sql.begin(async (tx) => {
          await tx`
            UPDATE research_stages
            SET status = 'running', failure_reason = NULL, completed_at = NULL,
                started_at = NOW(), updated_at = NOW()
            WHERE id = ${failedStage.id}
          `;
          await tx`
            UPDATE research_stages
            SET status = 'pending', failure_reason = NULL, completed_at = NULL,
                started_at = NULL, validation_result_json = NULL, updated_at = NOW()
            WHERE research_run_id = ${runId}
              AND stage_order > ${failedStage.stage_order}
              AND status IN ('cancelled', 'failed', 'running', 'waiting_for_human')
          `;
          await tx`
            UPDATE research_runs
            SET status = 'running', failure_reason = NULL, completed_at = NULL, updated_at = NOW()
            WHERE id = ${runId}
          `;
        });
        notes.push(`Resuming failed stage ${failedStage.stage_key}`);
      } else if (["completed", "failed", "cancelled"].includes(runStatus)) {
        return await result(sql, runId, notes);
      }

      const stages = await getStages(sql, runId);
      const manuallyFailed = stages.find(
        (stage) => stage.status === "failed" && !String(stage.failure_reason || "").startsWith("Failed after")
      );
      if (manuallyFailed) {
        const reason = `Run contains a failed stage (${manuallyFailed.stage_key}): ${manuallyFailed.failure_reason || "stage failure"}`;
        await markPipelineFailure(sql, runId, new Error(reason));
        notes.push(reason);
        return await result(sql, runId, notes);
      }
      const waiting = stages.find((stage) => stage.status === "waiting_for_human");
      if (waiting) {
        notes.push(`Stage ${waiting.stage_key} is waiting for human approval`);
        return await result(sql, runId, notes);
      }

      let active = stages.find((stage) => stage.status === "running");
      if (!active) {
        const failed = stages.filter((stage) => stage.status === "failed");
        const fatalFailed = failed.find((stage) => getStageConfig(stage.stage_key)?.failureState === "fail_run");
        if (fatalFailed) {
          const reason = `Run contains a failed required stage (${fatalFailed.stage_key}): ${fatalFailed.failure_reason || "stage failure"}`;
          await markPipelineFailure(sql, runId, new Error(reason));
          notes.push(reason);
          return await result(sql, runId, notes);
        }
        const next = stages.find((stage) => stage.status === "pending");
        if (!next) {
          const done = await finalizeIfComplete(sql, runId);
          if (done) return await result(sql, runId, notes);
          return await result(sql, runId, notes);
        }

        const nextContext = await loadRunContext(sql, runId);
        if (nextContext.composedProfile && shouldSkipOptionalBacktest(next.stage_key, nextContext.composedProfile.backtest_required)) {
          const reason = "No accepted timing hypothesis; fundamental synthesis does not require a framework backtest.";
          await sql`
            UPDATE research_stages
            SET status = 'skipped', failure_reason = ${reason},
                validation_result_json = ${sql.json({ valid: true, skipped: true, reason })},
                completed_at = NOW(), updated_at = NOW()
            WHERE id = ${next.id}
          `;
          notes.push(`Skipped optional stage ${next.stage_key}`);
          continue;
        }

        const config = getStageConfig(next.stage_key);
        if (config?.requiresHumanApproval) {
          // Human gates are entered only after their durable gate artifact exists.
          // The research plan is deterministic and is generated from the persisted
          // profile composition before the UI is allowed to approve it.
          if (next.stage_key === "research_plan") {
            const gateHandler = getStageHandler(next.stage_key);
            if (!gateHandler) {
              throw new Error("Research plan handler is not registered");
            }
            const gateContext = await loadRunContext(sql, runId);
            const gateOutput = await gateHandler.execute(gateContext);
            const gateValidation = await gateHandler.validate(gateContext, gateOutput);
            if (!gateValidation.valid) {
              await markPipelineFailure(sql, runId, new Error(gateValidation.errors.join("; ")));
              return await result(sql, runId, notes);
            }
          }
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

      const handler = getStageHandler(active.stage_key);
      if (!handler) {
        const message = `No stage handler registered for stage "${active.stage_key}"; failing closed`;
        await markPipelineFailure(sql, runId, new Error(message));
        notes.push(message);
        return await result(sql, runId, notes);
      }

      let ctx: ResearchRunContext;
      try {
        ctx = await loadRunContext(sql, runId);
        const output = await handler.execute(ctx);
        const handlerValidation = await handler.validate(ctx, output);

        if (!handlerValidation.valid) {
          await settleStageArtifacts(sql, runId, active.id, "rejected");
          await stageInvalidTasks(sql, runId, active.id, handlerValidation.errors);
          await sql`
            UPDATE research_tasks
            SET status = 'failed', validation_status = 'invalid',
                validation_result_json = ${sql.json(handlerValidation as any)},
                failure_reason = ${handlerValidation.errors.join("; ").slice(0, 4000)},
                updated_at = NOW()
            WHERE stage_id = ${active.id} AND status = 'completed'
          `;
          const retryCount = retryCountOf(active);
          const maxRetries = Number(active.max_retries ?? 2);
          if (retryCount < maxRetries) {
            await sql`
              UPDATE research_stages
              SET validation_result_json = ${sql.json({ ...handlerValidation, retryCount: retryCount + 1, handler: handler.stageKey })},
                  updated_at = NOW()
              WHERE id = ${active.id}
            `;
            notes.push(`Stage ${active.stage_key} handler validation failed (retry ${retryCount + 1}/${maxRetries})`);
            continue;
          }

          const config = getStageConfig(active.stage_key);
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
                  validation_result_json = ${sql.json(handlerValidation as any)},
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
        await settleStageArtifacts(sql, runId, active.id, "validated");
      } catch (error) {
        await settleStageArtifacts(sql, runId, active.id, "rejected").catch(() => undefined);
        await markPipelineFailure(sql, runId, error);
        notes.push(`Stage ${active.stage_key} execution failed: ${error instanceof Error ? error.message : String(error)}`);
        return await result(sql, runId, notes);
      }

      const advance = await advanceStage(runId);
      if (!advance.success && advance.action !== "retry") {
        notes.push(`Stage ${active.stage_key} could not advance: ${advance.error || advance.action}`);
        return await result(sql, runId, notes);
      }
      if (advance.action === "retry") {
        notes.push(`Stage ${active.stage_key} validation requested retry${advance.error ? `: ${advance.error}` : ""}`);
        continue;
      }
      if (advance.action === "skip_and_continue") {
        notes.push(`Stage ${active.stage_key} failed validation and continued${advance.error ? `: ${advance.error}` : ""}`);
        continue;
      }
      if (advance.action === "pause_for_human") {
        notes.push(`Stage ${active.stage_key} paused for human input${advance.error ? `: ${advance.error}` : ""}`);
        return await result(sql, runId, notes);
      }
      notes.push(`Completed stage ${active.stage_key}`);
    }

    throw new Error(`pipeline exceeded ${MAX_ITERATIONS} stage iterations for run ${runId}`);
  } catch (error) {
    const status = await getRunStatus(sql, runId).catch(() => "unknown");
    if (!["completed", "failed", "needs_more_work", "waiting_for_human", "cancelled"].includes(status)) {
      await markPipelineFailure(sql, runId, error);
    }
    notes.push(error instanceof Error ? error.message : String(error));
    return await result(sql, runId, notes);
  } finally {
    await sql.end();
  }
}

export { getRunProgress };
