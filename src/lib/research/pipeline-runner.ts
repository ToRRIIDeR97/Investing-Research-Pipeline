import postgres from "postgres";
import { advanceStage, startRun, startReadyStages, failRun, getRunProgress } from "@/lib/workflow/orchestrator";
import { loadRunContext } from "./run-context";
import { STAGE_HANDLERS } from "./handlers";
import { CURRENT_PIPELINE_VERSION } from "./version";
import { prepareResearchTeam, processResearchRequests, ResearchRequestsPending } from "./team";
import { processSourceRequests } from "./sources/collector";
import { SourceRequestsPending } from "./sources/source-requests";

export interface SystemPipelineResult {
  runId: string;
  status: string;
  completedStages: number;
  totalStages: number;
  notes: string[];
  failure_reason?: string | null;
}

/** Execute handlers; the workflow orchestrator owns every stage transition. */
export async function runResearchPipeline(runId: string): Promise<SystemPipelineResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const notes: string[] = [];
  const lease = await sql.reserve();
  let locked = false;
  try {
    const [lock] = await lease`SELECT pg_try_advisory_lock(hashtextextended(${`research-run:${runId}`}, 0)) AS acquired`;
    locked = Boolean(lock.acquired);
    if (!locked) throw new Error("Another worker is still executing this research run");
    const [run] = await sql`SELECT pipeline_version, status FROM research_runs WHERE id = ${runId}`;
    if (!run) throw new Error(`Research run not found: ${runId}`);
    if (Number(run.pipeline_version) !== CURRENT_PIPELINE_VERSION) {
      throw new Error(`Run ${runId} has unsupported pipeline_version ${run.pipeline_version}. Only pipeline_version ${CURRENT_PIPELINE_VERSION} is supported.`);
    }
    // Owning the session lock proves no previous runner can still be calling a model.
    await sql`UPDATE research_tasks SET status = 'failed', failure_reason = 'Interrupted worker attempt',
      input_json = input_json - 'budget_reservation', updated_at = NOW()
      WHERE research_run_id = ${runId} AND status = 'running'`;
    try {
      if (run.status === "pending") await startRun(runId);
      for (let iteration = 0; iteration < 192; iteration += 1) {
        const [state] = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
        if (state.status !== "running") break;
        const stages = await startReadyStages(runId);
        if (!stages.length) break;
        const context = await loadRunContext(sql, runId);
        await prepareResearchTeam(sql, context);
        // Specialists paused on document requests rerun once the collector has served them.
        if (await processSourceRequests(sql, context)) continue;
        if (await processResearchRequests(sql, context)) continue;
        // Drain all in-flight work before any failure, replay, or gate transition.
        const results = await Promise.allSettled(stages.map(async key => {
          const handler = STAGE_HANDLERS[key];
          if (!handler) throw new Error(`No stage handler for ${key}`);
          const output = await handler.execute(context);
          return handler.validate?.(context, output);
        }));
        let stop = false;
        for (let i = 0; i < stages.length; i++) {
          const result = results[i];
          if (result.status === "rejected") {
            if (result.reason instanceof ResearchRequestsPending || result.reason instanceof SourceRequestsPending) {
              notes.push(result.reason.message); continue;
            }
            throw result.reason;
          }
          const advance = await advanceStage(runId, result.value, { stageKey: stages[i], deferNext: true });
          notes.push(advance.error || `Stage ${stages[i]}: ${advance.action}`);
          if ((!advance.success && advance.action !== "retry") || advance.action === "pause_for_human") { stop = true; break; }
        }
        if (stop) break;
        if (iteration === 191) throw new Error("Pipeline exceeded 192 stage iterations");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await failRun(runId, reason, "needs_more_work");
      notes.push(reason);
    }
    const [result] = await sql`
      SELECT rr.status, rr.failure_reason,
        count(rs.id) FILTER (WHERE rs.status = 'completed') AS completed,
        count(rs.id) AS total
      FROM research_runs rr LEFT JOIN research_stages rs ON rs.research_run_id = rr.id
      WHERE rr.id = ${runId} GROUP BY rr.id
    `;
    return { runId, status: result.status, completedStages: Number(result.completed),
      totalStages: Number(result.total), notes, failure_reason: result.failure_reason };
  } finally {
    if (locked) await lease`SELECT pg_advisory_unlock(hashtextextended(${`research-run:${runId}`}, 0))`;
    lease.release();
    await sql.end();
  }
}

export { getRunProgress };
