/**
 * Research OS v3 run context and stage-handler shared services.
 *
 * The research runtime is deliberately separate from the legacy monolith:
 * each stage handler receives a ResearchRunContext and produces one bounded
 * artifact family. Model access goes through callResearchAgent, which enforces
 * budget preflight and per-attempt ledger recording identically to v2.
 */

import postgres from "postgres";
import { runResearchAgent } from "@/lib/agent-harness/runner";
import { assertModelBudgetAvailable, recordModelCall } from "@/lib/agents/model-calls";
import { composeProfile } from "./archetypes/compose";
import type { ComposedProfile } from "./archetypes/types";
import type { ValidationResult } from "@/lib/workflow/validators";
import { CURRENT_PIPELINE_VERSION } from "./version";
export type { ValidationResult };

export type Sql = ReturnType<typeof postgres>;

export const HANDLER_VERSION = "3.0.0";
export const SCHEMA_VERSION = "3.0.0";
export const VALIDATOR_VERSION = "1.0.0";
export const PROMPT_VERSION = "v3-runtime-v1";

export interface ResearchRunContext {
  runId: string;
  assetId: string;
  assetName: string;
  assetSlug: string;
  symbol: string;
  runType: string;
  pipelineVersion: typeof CURRENT_PIPELINE_VERSION;
  cutoffAt: Date;
  marketDataCutoffAt: Date | null;
  profileId: string | null;
  profileKey: string | null;
  researchQuestion: string;
  budgetLimitUsd: number;
  budgetSpentUsd: number;
  budgetRemainingUsd: number;
  testMode: boolean;
  syntheticFixtureId: string | null;
  composedProfile: ComposedProfile | null;
  archetypeKeys: string[];
  overlayKeys: string[];
  timingHypothesis: {
    hypothesis_text: string;
    accepted: boolean;
    accepted_at?: string;
    accepted_by?: string;
  } | null;
}

export interface StageHandler<TOutput = unknown> {
  stageKey: string;
  execute(context: ResearchRunContext): Promise<TOutput>;
  validate(context: ResearchRunContext, output: TOutput): Promise<ValidationResult>;
}

type RunRow = {
  id: string;
  run_type: string;
  status: string;
  asset_id: string;
  profile_id: string | null;
  research_question: string | null;
  source_cutoff_at: string | Date | null;
  market_data_cutoff_at: string | Date | null;
  budget_limit_usd: string | number | null;
  actual_cost_usd: string | number | null;
  pipeline_version: number | string | null;
  metadata_json: unknown;
  canonical_name: string;
  slug: string;
  profile_key: string | null;
  symbol: string | null;
};

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Load the run-scoped context for a execution. The composed profile is
 * rebuilt from run metadata when an archetype composition has already been
 * accepted; otherwise it is composed on demand from the requested archetypes
 * so later handlers can rely on it without re-deriving asset identity.
 */
export async function loadRunContext(sql: Sql, runId: string): Promise<ResearchRunContext> {
  const rows = await sql<RunRow[]>`
    SELECT
      rr.id, rr.run_type, rr.status, rr.asset_id, rr.profile_id,
      rr.research_question, rr.source_cutoff_at, rr.market_data_cutoff_at,
      rr.budget_limit_usd, rr.actual_cost_usd, rr.pipeline_version, rr.metadata_json,
      a.canonical_name, a.slug,
      rp.profile_key,
      l.symbol
    FROM research_runs rr
    JOIN assets a ON a.id = rr.asset_id
    LEFT JOIN research_profiles rp ON rp.id = rr.profile_id
    LEFT JOIN instruments i ON i.asset_id = a.id
    LEFT JOIN listings l ON l.instrument_id = i.id AND l.active_to IS NULL
    WHERE rr.id = ${runId}
    ORDER BY l.is_primary DESC NULLS LAST, l.created_at ASC NULLS LAST
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`Research run not found: ${runId}`);
  const pipelineVersion = Number(row.pipeline_version || 1);
  if (pipelineVersion !== CURRENT_PIPELINE_VERSION) {
    throw new Error(`Run ${runId} has unsupported pipeline_version ${pipelineVersion}. Only pipeline_version ${CURRENT_PIPELINE_VERSION} is supported.`);
  }

  const metadata = asObject(row.metadata_json);
  const archetypeKeys = Array.isArray(metadata.v3_archetypes)
    ? (metadata.v3_archetypes as unknown[]).map(String)
    : [];
  const overlayKeys = Array.isArray(metadata.v3_overlays)
    ? (metadata.v3_overlays as unknown[]).map(String)
    : [];
  const timingHypothesis = metadata.timing_hypothesis && typeof metadata.timing_hypothesis === "object"
    ? (metadata.timing_hypothesis as ResearchRunContext["timingHypothesis"])
    : null;

  let composedProfile: ComposedProfile | null = null;
  if (archetypeKeys.length > 0) {
    const { profile, errors } = composeProfile(
      `${row.slug}-v3`,
      row.asset_id,
      archetypeKeys,
      overlayKeys,
      timingHypothesis || undefined
    );
    if (!errors.some((error) => error.code === "conflict")) {
      composedProfile = profile;
    }
  }

  const cutoffAt = row.source_cutoff_at ? new Date(row.source_cutoff_at) : new Date();
  const budgetLimit = Number(row.budget_limit_usd || 0);
  const budgetSpent = Number(row.actual_cost_usd || 0);

  return {
    runId,
    assetId: row.asset_id,
    assetName: row.canonical_name,
    assetSlug: row.slug,
    symbol: String(row.symbol || row.slug).toUpperCase(),
    runType: row.run_type,
    pipelineVersion: CURRENT_PIPELINE_VERSION,
    cutoffAt,
    marketDataCutoffAt: row.market_data_cutoff_at ? new Date(row.market_data_cutoff_at) : null,
    profileId: row.profile_id,
    profileKey: row.profile_key,
    researchQuestion: row.research_question || "",
    budgetLimitUsd: budgetLimit,
    budgetSpentUsd: budgetSpent,
    budgetRemainingUsd: Math.max(0, budgetLimit - budgetSpent),
    testMode: process.env.RESEARCH_TEST_MODE === "1",
    syntheticFixtureId: process.env.RESEARCH_TEST_MODE === "1"
      ? String(metadata.synthetic_fixture_id || `fixture:${row.slug}:v3`)
      : null,
    composedProfile,
    archetypeKeys,
    overlayKeys,
    timingHypothesis,
  };
}

/**
 * Persist the accepted archetype composition on the run so every later
 * handler and resume shares the same composed profile.
 */
export async function persistV3Composition(
  sql: Sql,
  runId: string,
  archetypes: string[],
  overlays: string[]
): Promise<void> {
  // JSONB || concatenation requires a raw SQL literal; use JSON.stringify
  // with proper SQL string escaping (double single quotes).
  const value = JSON.stringify({ v3_archetypes: archetypes, v3_overlays: overlays }).replace(/'/g, "''");
  await sql`
    UPDATE research_runs
    SET metadata_json = coalesce(metadata_json, '{}'::jsonb)
                         || ${sql.unsafe(`'${value}'::jsonb`)},
        updated_at = NOW()
    WHERE id = ${runId}
  `;
}

export async function createV3Task(
  sql: Sql,
  runId: string,
  stageKey: string,
  taskKey: string,
  taskType: string,
  agentName: string
): Promise<{ id: string; stage_id: string }> {
  const existing = await sql`
    SELECT id, stage_id, status FROM research_tasks
    WHERE research_run_id = ${runId} AND task_key = ${taskKey}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (existing[0] && existing[0].status === "completed") {
    return { id: existing[0].id, stage_id: existing[0].stage_id };
  }
  // Find the stage_id first (avoid INSERT...SELECT which breaks sql.json in postgres.js v3.4.5)
  const stage = await sql`
    SELECT id FROM research_stages
    WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
    LIMIT 1
  `;
  if (!stage[0]) throw new Error(`Stage not found for task: ${stageKey}`);
  const rows = await sql`
    INSERT INTO research_tasks (
      research_run_id, stage_id, task_key, task_type, agent_name,
      status, priority, input_json, started_at
    ) VALUES (
      ${runId}, ${stage[0].id}, ${taskKey}, ${taskType}, ${agentName},
      'running', 80, ${JSON.stringify({ system_generated: true, pipeline_version: CURRENT_PIPELINE_VERSION })}::jsonb, NOW()
    )
    RETURNING id, stage_id
  `;
  return rows[0] as { id: string; stage_id: string };
}

export async function latestV3TaskOutput(
  sql: Sql,
  runId: string,
  taskKey: string
): Promise<Record<string, unknown> | null> {
  const rows = await sql`
    SELECT output_json
    FROM research_tasks
    WHERE research_run_id = ${runId}
      AND task_key = ${taskKey}
      AND status = 'completed'
      AND output_json IS NOT NULL
    ORDER BY completed_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  const output = rows[0]?.output_json;
  if (output && typeof output === "object") return output as Record<string, unknown>;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function completeV3Task(sql: Sql, taskId: string, output: unknown): Promise<void> {
  await sql`
    UPDATE research_tasks
    SET status = 'completed',
        output_json = ${JSON.stringify(output ?? {})}::jsonb,
        failure_reason = NULL,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

export async function failV3Task(sql: Sql, taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE research_tasks
    SET status = 'failed',
        failure_reason = ${message.slice(0, 4000)},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

export function exactJsonPrompt(params: {
  agentName: string;
  requiredKeys: string[];
  packet: Record<string, unknown>;
  extraRules?: string[];
}): string {
  return [
    `Run Research OS v3 agent: ${params.agentName}.`,
    "",
    "Return exactly one JSON object. Do not return Markdown, prose, code fences, or nested wrapper objects.",
    `The top-level object must contain exactly these required keys: ${params.requiredKeys.join(", ")}.`,
    "For every top-level artifact object, artifact_type must exactly equal its enclosing top-level key.",
    "If evidence is insufficient, return empty arrays for the relevant fields and explain gaps in source_gaps or unresolved fields.",
    ...(params.extraRules || []),
    "",
    "Task packet:",
    JSON.stringify(params.packet, null, 2),
  ].join("\n");
}

/**
 * Bounded agent call for v3 handlers. Mirrors the v2 callAgent behavior:
 * budget preflight before every attempt and a per-attempt model-call ledger.
 */
export async function callResearchAgent<T extends Record<string, unknown>>(params: {
  sql: Sql;
  ctx: ResearchRunContext;
  stageKey: string;
  taskKey: string;
  taskType: string;
  agentName: Parameters<typeof runResearchAgent>[0]["agentName"];
  modelTier: string;
  packet: Record<string, unknown>;
  prompt?: string;
  promptFactory?: (packet: Record<string, unknown>) => string;
  outputFormat?: Parameters<typeof runResearchAgent>[0]["outputFormat"];
}): Promise<T> {
  const task = await createV3Task(params.sql, params.ctx.runId, params.stageKey, params.taskKey, params.taskType, params.agentName);
  const prior = await latestV3TaskOutput(params.sql, params.ctx.runId, params.taskKey);
  if (prior) return prior as T;

  const escalationReason = params.modelTier === "premium" || params.modelTier === "specialist"
    ? "Research OS v3 stage requires specialist reasoning"
    : undefined;
  let recordedAttempts = 0;
  try {
    const result = await runResearchAgent<T>({
      agentName: params.agentName,
      title: `${params.agentName} ${params.ctx.symbol} ${params.ctx.runId}`,
      taskPacket: params.packet,
      prompt: params.prompt,
      promptFactory: params.promptFactory,
      outputFormat: params.outputFormat,
      hooks: {
        beforeAttempt: async () => {
          await assertModelBudgetAvailable({
            researchRunId: params.ctx.runId,
            stageId: task.stage_id,
            taskId: task.id,
            modelTier: params.modelTier,
            reserveUsd: Number(process.env.RESEARCH_ATTEMPT_BUDGET_RESERVE_USD || 0.1),
          });
        },
        onAttemptComplete: async (attempt) => {
          recordedAttempts += 1;
          await recordModelCall({
            researchRunId: params.ctx.runId,
            stageId: task.stage_id,
            taskId: task.id,
            agentName: params.agentName,
            modelProvider: attempt.provider,
            modelName: attempt.model,
            modelTier: params.modelTier,
            promptVersion: PROMPT_VERSION,
            inputTokens: attempt.inputTokens,
            outputTokens: attempt.outputTokens,
            costUsd: attempt.costUsd,
            latencyMs: attempt.latencyMs,
            status: attempt.status,
            errorMessage: attempt.errorMessage,
            requestMetadata: {
              attempt: attempt.attempt,
              fallback: attempt.fallback,
              model_attempt: attempt.modelAttempt,
              compaction_occurred: attempt.compactionOccurred,
              input_bytes: attempt.inputBytes,
              original_input_bytes: attempt.originalInputBytes,
            },
            responseMetadata: {
              request_id: attempt.requestId,
              started_at: attempt.startedAt,
              completed_at: attempt.completedAt,
              error_category: attempt.errorCategory,
              timeout_type: attempt.timeoutType,
              reasoning_tokens: attempt.reasoningTokens,
              repair_attempted: attempt.repairAttempted,
              validation_errors: attempt.validationErrors,
              raw_response_excerpt: attempt.rawResponseExcerpt,
              tool_calls: attempt.toolCalls,
              provider_requests: attempt.passes,
              local_coercion_applied: attempt.localCoercionApplied,
              completion_recovered_at_timeout: attempt.completionRecoveredAtTimeout,
            },
            escalationReason,
          });
        },
      },
    });
    await completeV3Task(params.sql, task.id, result.structured);
    return result.structured as T;
  } catch (error) {
    if (!recordedAttempts) {
      await recordModelCall({
        researchRunId: params.ctx.runId,
        stageId: task.stage_id,
        taskId: task.id,
        agentName: params.agentName,
        modelProvider: process.env.RESEARCH_MODEL_PROVIDER || "local-harness",
        modelName: "not-started",
        modelTier: params.modelTier,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        responseMetadata: { pre_attempt_failure: true },
        escalationReason,
      });
    }
    await failV3Task(params.sql, task.id, error);
    throw error;
  }
}

export function makeValidationResult(errors: string[] = [], warnings: string[] = []): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}
