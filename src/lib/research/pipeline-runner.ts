import postgres from "postgres";
import { advanceStage, startRun, startReadyStages, failRun, getRunProgress } from "@/lib/workflow/orchestrator";
import type { ValidationResult } from "@/lib/workflow/validators";
import { ResearchAgentRunError } from "@/lib/agent-harness/errors";
import { loadRunContext, type Sql } from "./run-context";
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

/** Another worker holds the run's session lock; the job should wait, not fail. */
export class ResearchRunLocked extends Error {}
/** The caller aborted the run (worker shutdown, lost lease or cancellation); the run was left resumable. */
export class ResearchRunInterrupted extends Error {}

// Provider and stream failures that a later attempt can clear; quota, authentication and request errors cannot.
const TRANSIENT_AGENT_ERRORS = new Set(["provider_timeout", "malformed_stream", "connection", "server_error", "rate_limit", "output_exhausted"]);

export function isTransientAgentError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof ResearchAgentRunError) return TRANSIENT_AGENT_ERRORS.has(String(current.responseMetadata.error_type));
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

type Advance = { success: boolean; action?: string; error?: string };
export interface StageFailure { stageKey: string; reason: unknown }

/**
 * Advance every stage that finished before handling any that failed, so a failing stage does not discard
 * finished siblings. Paused requests become notes; the other rejections are returned.
 */
export async function settleBatch(
  stages: string[],
  results: PromiseSettledResult<ValidationResult | undefined>[],
  advance: (stageKey: string, value: ValidationResult | undefined) => Promise<Advance>,
  notes: string[]
): Promise<{ stop: boolean; failures: StageFailure[] }> {
  let stop = false;
  for (let i = 0; i < stages.length && !stop; i++) {
    const result = results[i];
    if (result.status === "rejected") continue;
    const outcome = await advance(stages[i], result.value);
    notes.push(outcome.error || `Stage ${stages[i]}: ${outcome.action}`);
    stop = (!outcome.success && outcome.action !== "retry") || outcome.action === "pause_for_human";
  }
  const failures: StageFailure[] = [];
  results.forEach((result, i) => {
    if (result.status !== "rejected") return;
    if (result.reason instanceof ResearchRequestsPending || result.reason instanceof SourceRequestsPending) notes.push(result.reason.message);
    else failures.push({ stageKey: stages[i], reason: result.reason });
  });
  return { stop, failures };
}

/**
 * A stage whose model call failed transiently stays running and is dispatched again after a backoff, up to its
 * configured max_retries. Returns false when any failing stage has used its retries.
 */
async function retryTransientFailures(sql: Sql, runId: string, failures: StageFailure[], notes: string[], signal?: AbortSignal) {
  if (!failures.every((failure) => isTransientAgentError(failure.reason))) return false;
  const keys = failures.map((failure) => failure.stageKey);
  const rows = await sql`SELECT stage_key, max_retries, COALESCE((validation_result_json->>'transient_failures')::int, 0) AS failures
    FROM research_stages WHERE research_run_id = ${runId} AND stage_key = ANY(${keys}::text[]) AND status = 'running'`;
  if (rows.length !== keys.length || rows.some((row) => Number(row.failures) >= Number(row.max_retries ?? 2))) return false;
  for (const failure of failures) {
    const message = (failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).slice(0, 1000);
    await sql`UPDATE research_stages SET validation_result_json = COALESCE(validation_result_json, '{}'::jsonb)
        || jsonb_build_object('transient_failures', COALESCE((validation_result_json->>'transient_failures')::int, 0) + 1,
          'last_transient_error', ${message}::text),
        updated_at = NOW()
      WHERE research_run_id = ${runId} AND stage_key = ${failure.stageKey}`;
    notes.push(`Stage ${failure.stageKey}: transient failure, retrying (${message})`);
  }
  const used = Math.max(...rows.map((row) => Number(row.failures))) + 1;
  const configured = Number(process.env.RESEARCH_STAGE_RETRY_DELAY_MS);
  const base = process.env.RESEARCH_STAGE_RETRY_DELAY_MS && Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
  await sleep(Math.min(120_000, base * 2 ** (used - 1)), signal);
  return true;
}

/** Execute handlers; the workflow orchestrator owns every stage transition. */
export async function runResearchPipeline(runId: string, options: { signal?: AbortSignal } = {}): Promise<SystemPipelineResult> {
  const { signal } = options;
  const sql = postgres(process.env.DATABASE_URL!);
  const notes: string[] = [];
  const lease = await sql.reserve();
  let locked = false;
  let interrupted = false;
  try {
    const [lock] = await lease`SELECT pg_try_advisory_lock(hashtextextended(${`research-run:${runId}`}, 0)) AS acquired`;
    locked = Boolean(lock.acquired);
    if (!locked) throw new ResearchRunLocked("Another worker is still executing this research run");
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
        if (signal?.aborted) throw new ResearchRunInterrupted("Research run interrupted");
        const [state] = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
        if (state.status !== "running") break;
        const stages = await startReadyStages(runId);
        if (!stages.length) {
          // A run left running with nothing to dispatch would only be requeued by the reconcile step; stop it visibly.
          const [after] = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
          if (after?.status === "running") throw new Error("No stage can run, but the run is still running");
          break;
        }
        const context = { ...(await loadRunContext(sql, runId)), signal };
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
        const { stop, failures } = await settleBatch(stages, results, (stageKey, value) =>
          advanceStage(runId, value, { stageKey, deferNext: true }), notes);
        if (signal?.aborted) throw new ResearchRunInterrupted("Research run interrupted");
        if (failures.length) {
          if (!stop && await retryTransientFailures(sql, runId, failures, notes, signal)) continue;
          // The stage's outputs led to the throw, including ones replayed from an earlier attempt (they keep their
          // original completed_at), so a resume must call the model again rather than replay any of them.
          const fatal = failures.filter((failure) => !isTransientAgentError(failure.reason));
          if (fatal.length) await sql`UPDATE research_tasks SET validation_status = 'invalid', updated_at = NOW()
            WHERE research_run_id = ${runId} AND status = 'completed'
              AND stage_id IN (SELECT id FROM research_stages WHERE research_run_id = ${runId}
                AND stage_key = ANY(${fatal.map((failure) => failure.stageKey)}::text[]))`;
          throw (fatal[0] ?? failures[0]).reason;
        }
        if (stop) break;
        if (iteration === 191) throw new Error("Pipeline exceeded 192 stage iterations");
      }
    } catch (error) {
      if (signal?.aborted) {
        // Leave the running stage as it is; the requeued job reruns it.
        interrupted = true;
        notes.push("Research run interrupted");
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        await failRun(runId, reason, "needs_more_work");
        notes.push(reason);
      }
    }
    if (interrupted) throw new ResearchRunInterrupted(`Research run ${runId} interrupted`);
    const [result] = await sql`
      SELECT rr.status, rr.failure_reason,
        count(rs.id) FILTER (WHERE rs.status = 'completed') AS completed,
        count(rs.id) AS total
      FROM research_runs rr LEFT JOIN research_stages rs ON rs.research_run_id = rr.id
      WHERE rr.id = ${runId} GROUP BY rr.id
    `;
    console.log(`research run ${runId}: pipeline stopped with status ${result.status}`);
    return { runId, status: result.status, completedStages: Number(result.completed),
      totalStages: Number(result.total), notes, failure_reason: result.failure_reason };
  } finally {
    if (locked) await lease`SELECT pg_advisory_unlock(hashtextextended(${`research-run:${runId}`}, 0))`;
    lease.release();
    // Bounded: a stalled connection must not keep the worker from closing the job (seen in run dd02bb41).
    await sql.end({ timeout: 5 });
  }
}

export { getRunProgress };
