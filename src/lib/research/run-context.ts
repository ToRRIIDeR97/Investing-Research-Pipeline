/**
 * Research OS v4 run context and stage-handler shared services.
 *
 * The research runtime is deliberately separate from the legacy monolith:
 * each stage handler receives a ResearchRunContext and produces one bounded
 * artifact family. Model access goes through callResearchAgent, which enforces
 * budget preflight and per-attempt ledger recording identically to v2.
 */

import postgres from "postgres";
import { runResearchAgent } from "@/lib/agent-harness/runner";
import { PostgresAgentSessionStore } from "@/lib/agent-harness/session-store";
import { getAgentConfig } from "@/lib/agent-harness/registry";
import { validateSchema } from "@/lib/agent-harness/validation";
import { assertModelBudgetAvailable, recordModelCall, releaseModelBudgetReservation } from "@/lib/agents/model-calls";
import { composeProfile } from "./archetypes/compose";
import type { ComposedProfile } from "./archetypes/types";
import type { ValidationResult } from "@/lib/workflow/validators";
import { CURRENT_PIPELINE_VERSION } from "./version";
import { contractForArtifact } from "./stage-contracts";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
export type { ValidationResult };

export type Sql = ReturnType<typeof postgres>;

export const HANDLER_VERSION = "4.0.0";
export const SCHEMA_VERSION = "4.0.0";
export const VALIDATOR_VERSION = "2.0.0";
export const PROMPT_VERSION = "v4-runtime-v1";

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

async function stageRejectedOutput(
  sql: Sql,
  params: { runId: string; stageId: string; taskId: string; agentName: string; schemaKey: string; error: unknown }
) {
  const errorMessage = params.error instanceof Error ? params.error.message : String(params.error);
  const details = params.error && typeof params.error === "object" ? params.error as Record<string, unknown> : {};
  const rawResponseExcerpt = typeof details.raw_response_excerpt === "string" ? details.raw_response_excerpt : null;
  await sql`
    INSERT INTO agent_output_staging (
      research_run_id, stage_id, task_id, target_table,
      output_schema_key, output_schema_version, payload_json,
      validation_status, validation_errors_json, review_status, created_by_agent, rejected_at, rejection_reason
    ) VALUES (
      ${params.runId}, ${params.stageId}, ${params.taskId}, 'research_tasks',
      ${params.schemaKey}, 4,
      ${sql.json({ error: errorMessage, raw_response_excerpt: rawResponseExcerpt })},
      'invalid', ${sql.json([errorMessage])}, 'rejected', ${params.agentName}, NOW(), ${errorMessage.slice(0, 4000)}
    )
  `;
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
    if (errors.length === 0) {
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
  const value = { v3_archetypes: archetypes, v3_overlays: overlays };
  await sql`
    UPDATE research_runs
    SET metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END)
                         || ${sql.json(value)},
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
): Promise<{ id: string; stage_id: string; taskKey: string; priorValidationErrors: string[] }> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${runId}:${stageKey}:${taskKey}`}, 0))`;
    const stage = await tx`
      SELECT id FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
      LIMIT 1
    `;
    if (!stage[0]) throw new Error(`Stage not found for task: ${stageKey}`);

    const valid = await tx`
      SELECT id, stage_id, task_key FROM research_tasks
      WHERE research_run_id = ${runId} AND stage_id = ${stage[0].id}
        AND (task_key = ${taskKey} OR task_key LIKE ${`${taskKey}:revision-%`})
        AND status = 'completed' AND validation_status = 'valid' AND output_json IS NOT NULL
      ORDER BY completed_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `;
    if (valid[0]) {
      return { id: valid[0].id, stage_id: valid[0].stage_id, taskKey: String(valid[0].task_key), priorValidationErrors: [] };
    }

    const existing = await tx`
      SELECT id, stage_id, status, validation_status, validation_result_json, failure_reason, task_key
      FROM research_tasks
      WHERE research_run_id = ${runId} AND stage_id = ${stage[0].id}
        AND (task_key = ${taskKey} OR task_key LIKE ${`${taskKey}:revision-%`})
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `;
    if (existing[0] && ["pending", "running"].includes(String(existing[0].status))) {
      if (existing[0].status === "pending") {
        await tx`UPDATE research_tasks SET status = 'running', started_at = NOW(), updated_at = NOW() WHERE id = ${existing[0].id}`;
      }
      return { id: existing[0].id, stage_id: existing[0].stage_id, taskKey: String(existing[0].task_key), priorValidationErrors: [] };
    }
    if (existing[0] && ["completed", "failed"].includes(String(existing[0].status))) {
      await tx`
        UPDATE research_tasks
        SET status = 'failed', validation_status = 'invalid',
            failure_reason = 'Completed output failed downstream validation', updated_at = NOW()
        WHERE id = ${existing[0].id}
      `;
    }
    const priorValidationErrors = existing[0]
      ? [
          ...(existing[0].validation_result_json && typeof existing[0].validation_result_json === "object"
            ? (Array.isArray((existing[0].validation_result_json as Record<string, unknown>).errors)
              ? ((existing[0].validation_result_json as Record<string, unknown>).errors as unknown[]).map(String)
              : [])
            : []),
          existing[0].failure_reason ? String(existing[0].failure_reason) : "",
        ].filter(Boolean)
      : [];
    const revision = existing[0]
      ? Number(String(existing[0].task_key).match(/:revision-(\d+)$/)?.[1] || 0) + 1
      : 0;
    const effectiveTaskKey = revision > 0 ? `${taskKey}:revision-${revision}` : taskKey;
    const rows = await tx`
      INSERT INTO research_tasks (
        research_run_id, stage_id, task_key, task_type, agent_name,
        status, priority, input_json, started_at
      ) VALUES (
        ${runId}, ${stage[0].id}, ${effectiveTaskKey}, ${taskType}, ${agentName},
        'running', 80, ${JSON.stringify({ system_generated: true, pipeline_version: CURRENT_PIPELINE_VERSION })}::jsonb, NOW()
      )
      RETURNING id, stage_id
    `;
    return { ...(rows[0] as { id: string; stage_id: string }), taskKey: effectiveTaskKey, priorValidationErrors };
  });
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
      AND (task_key = ${taskKey} OR task_key LIKE ${`${taskKey}:revision-%`})
      AND status = 'completed'
      AND validation_status = 'valid'
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
  const serialized = JSON.stringify(output ?? {});
  const rows = await sql`
    UPDATE research_tasks
    SET status = 'completed',
        validation_status = 'valid',
        output_json = ${serialized}::jsonb,
        failure_reason = NULL,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
      AND (status = 'running' OR (status = 'completed' AND output_json IS NOT DISTINCT FROM ${serialized}::jsonb))
    RETURNING id
  `;
  if (!rows[0]) throw new Error(`Task ${taskId} is no longer claimable for completion`);
}

export async function failV3Task(sql: Sql, taskId: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  const rows = await sql`
    UPDATE research_tasks
    SET status = 'failed',
        validation_status = 'invalid',
        failure_reason = ${message},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
      AND (status IN ('pending', 'running') OR (status = 'failed' AND failure_reason = ${message}))
    RETURNING id
  `;
  if (!rows[0]) throw new Error(`Task ${taskId} is no longer claimable for failure`);
}

async function invalidateCachedV3Task(sql: Sql, taskId: string, reason: string): Promise<void> {
  const rows = await sql`
    UPDATE research_tasks
    SET status = 'failed',
        validation_status = 'invalid',
        failure_reason = ${reason},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${taskId}
      AND status = 'completed'
      AND validation_status = 'valid'
    RETURNING id
  `;
  if (!rows[0]) throw new Error(`Cached task ${taskId} is no longer claimable for invalidation`);
}

export function exactJsonPrompt(params: {
  agentName: string;
  requiredKeys: string[];
  packet: Record<string, unknown>;
  extraRules?: string[];
}): string {
  return [
    `Run Research OS v4 agent: ${params.agentName}.`,
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
 * Bounded agent call for v4 handlers. Mirrors the v2 callAgent behavior:
 * budget preflight before every attempt and a per-attempt model-call ledger.
 */
export async function callResearchAgent<T extends Record<string, unknown>>(params: {
  sql: Sql;
  ctx: ResearchRunContext;
  stageKey: string;
  taskKey: string;
  taskType: string;
  agentName: Parameters<typeof runResearchAgent>[0]["agentName"];
  /** @deprecated The registry is the source of truth; retained for V3 callers. */
  modelTier?: string;
  packet: Record<string, unknown>;
  signal?: AbortSignal;
  prompt?: string;
  promptFactory?: (packet: Record<string, unknown>) => string;
  outputFormat?: Parameters<typeof runResearchAgent>[0]["outputFormat"];
  validateStructured?: Parameters<typeof runResearchAgent>[0]["validateStructured"];
}): Promise<T> {
  const agentConfig = getAgentConfig(params.agentName);
  const resolvedTier = agentConfig.modelTier;
  const stageRows = await params.sql`
    SELECT id, allowed_model_tiers FROM research_stages
    WHERE research_run_id = ${params.ctx.runId} AND stage_key = ${params.stageKey}
    LIMIT 1
  `;
  if (!stageRows[0]) throw new Error(`Stage not found for task: ${params.stageKey}`);
  const allowedTiers = Array.isArray(stageRows[0]?.allowed_model_tiers)
    ? stageRows[0].allowed_model_tiers.map(String)
    : [];
  if (allowedTiers.length && !allowedTiers.includes(resolvedTier)) {
    throw new Error(`Agent ${params.agentName} resolves to tier ${resolvedTier}, which is not allowed for stage ${params.stageKey}`);
  }
  let task = await createV3Task(params.sql, params.ctx.runId, params.stageKey, params.taskKey, params.taskType, params.agentName);
  let prior = await latestV3TaskOutput(params.sql, params.ctx.runId, task.taskKey);
  if (prior) {
    const outputFormat = params.outputFormat || agentConfig.outputFormat;
    const cachedErrors = [
      ...validateSchema(prior, outputFormat),
      ...(params.validateStructured ? params.validateStructured(prior) : []),
    ];
    if (cachedErrors.length === 0) {
      // createV3Task checkpoints the current invocation before cache lookup;
      // close that task so a valid cache hit never leaves a phantom running
      // task in the ledger.
      await completeV3Task(params.sql, task.id, prior);
      return prior as T;
    }

    const reason = `Cached output failed current validation: ${cachedErrors.map((error) => `${error.path}: ${error.message}`).join(" | ")}`;
    await stageRejectedOutput(params.sql, {
      runId: params.ctx.runId,
      stageId: task.stage_id,
      taskId: task.id,
      agentName: params.agentName,
      schemaKey: params.stageKey,
      error: reason,
    }).catch(() => undefined);
    await invalidateCachedV3Task(params.sql, task.id, reason);
    task = await createV3Task(params.sql, params.ctx.runId, params.stageKey, params.taskKey, params.taskType, params.agentName);
    prior = null;
  }

  const escalationReason = resolvedTier === "premium" || resolvedTier === "specialist"
    ? "Research OS v4 stage requires specialist reasoning"
    : undefined;
  let recordedAttempts = 0;
  let reservationId: string | undefined;
  try {
    const packet = task.priorValidationErrors.length
      ? { ...params.packet, prior_validation_errors: task.priorValidationErrors }
      : params.packet;
    const result = await runResearchAgent<T>({
      agentName: params.agentName,
      title: `${params.agentName} ${params.ctx.symbol} ${params.ctx.runId}`,
      taskPacket: packet,
      prompt: params.prompt,
      promptFactory: params.promptFactory ? () => params.promptFactory!(packet) : undefined,
      outputFormat: params.outputFormat,
      validateStructured: params.validateStructured,
      signal: params.signal,
      session: {
        inputId: task.id,
        researchRunId: params.ctx.runId,
        stageId: task.stage_id,
        taskId: task.id,
        metadata: { stageKey: params.stageKey, taskKey: task.taskKey, taskType: params.taskType },
        store: new PostgresAgentSessionStore(params.sql),
      },
      hooks: {
        beforeAttempt: async () => {
          reservationId = await assertModelBudgetAvailable({
            researchRunId: params.ctx.runId,
            stageId: task.stage_id,
            taskId: task.id,
            modelTier: resolvedTier,
            reserveUsd: Number(process.env.RESEARCH_ATTEMPT_BUDGET_RESERVE_USD || 0.1),
          });
        },
        onAttemptComplete: async (attempt) => {
          recordedAttempts += 1;
          const attemptReservationId = reservationId;
          const reservationReconciledByCost = attempt.status === "success" || attempt.costUsd > 0;
          await recordModelCall({
            researchRunId: params.ctx.runId,
            stageId: task.stage_id,
            taskId: task.id,
            agentName: params.agentName,
            modelProvider: attempt.provider,
            modelName: attempt.model,
            modelTier: resolvedTier,
            promptVersion: PROMPT_VERSION,
            inputTokens: attempt.inputTokens,
            outputTokens: attempt.outputTokens,
            costUsd: attempt.costUsd,
            costSource: attempt.costSource,
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
              completion_recovered_without_marker: attempt.completionRecoveredWithoutMarker,
            },
            escalationReason,
            reservationId: reservationReconciledByCost ? attemptReservationId : undefined,
          });
          if (attemptReservationId && !reservationReconciledByCost) {
            await releaseModelBudgetReservation(attemptReservationId).catch(() => undefined);
          }
          reservationId = undefined;
        },
      },
    });
    await completeV3Task(params.sql, task.id, result.structured);
    return result.structured as T;
  } catch (error) {
    if (reservationId) await releaseModelBudgetReservation(reservationId).catch(() => undefined);
    if (!recordedAttempts) {
      await recordModelCall({
        researchRunId: params.ctx.runId,
        stageId: task.stage_id,
        taskId: task.id,
        agentName: params.agentName,
        modelProvider: process.env.RESEARCH_MODEL_PROVIDER || "local-harness",
        modelName: "not-started",
        modelTier: resolvedTier,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        responseMetadata: { pre_attempt_failure: true },
        escalationReason,
      });
    }
    await stageRejectedOutput(params.sql, {
      runId: params.ctx.runId,
      stageId: task.stage_id,
      taskId: task.id,
      agentName: params.agentName,
      schemaKey: params.stageKey,
      error,
    }).catch(() => undefined);
    await failV3Task(params.sql, task.id, error).catch(() => undefined);
    throw error;
  }
}

/** Execute and checkpoint each top-level artifact in a compound contract independently. */
export async function callResearchAgentArtifacts(params: {
  sql: Sql;
  ctx: ResearchRunContext;
  stageKey: string;
  taskKeyPrefix: string;
  taskType: string;
  agentName: Parameters<typeof runResearchAgent>[0]["agentName"];
  /** @deprecated Registry-derived tier is used by callResearchAgent. */
  modelTier?: string;
  packet: Record<string, unknown>;
  signal?: AbortSignal;
  outputFormat: AgentOutputFormat;
  promptFactory: (packet: Record<string, unknown>, artifactKey: string) => string;
  validateArtifact?: (
    artifactKey: string,
    value: unknown
  ) => Pick<ValidationResult, "valid" | "errors" | "warnings">;
  onArtifact?: (artifactKey: string, value: Record<string, unknown>) => Promise<void> | void;
  artifactWaves?: string[][];
}): Promise<Record<string, Record<string, unknown>>> {
  const artifacts: Record<string, Record<string, unknown>> = {};
  const waves = params.artifactWaves?.length
    ? params.artifactWaves
    : params.outputFormat.requiredKeys.map((artifactKey) => [artifactKey]);
  for (const wave of waves) {
    const waveAbort = new AbortController();
    const abortParent = () => waveAbort.abort();
    if (params.signal?.aborted) waveAbort.abort();
    else params.signal?.addEventListener("abort", abortParent, { once: true });
    const results = await Promise.allSettled(wave.map(async (artifactKey) => {
      try {
        const artifactContract = contractForArtifact(params.outputFormat, artifactKey);
        const packet = {
          ...params.packet,
          output_contract: artifactKey,
          output_schema: artifactContract.schema,
          accepted_artifacts: artifacts,
        };
        const output = await callResearchAgent<Record<string, Record<string, unknown>>>({
          sql: params.sql,
          ctx: params.ctx,
          stageKey: params.stageKey,
          taskKey: `${params.taskKeyPrefix}:${artifactKey}`,
          taskType: params.taskType,
          agentName: params.agentName,
          modelTier: params.modelTier,
          packet,
          signal: waveAbort.signal,
          promptFactory: (currentPacket) => params.promptFactory(currentPacket, artifactKey),
          outputFormat: artifactContract,
          validateStructured: params.validateArtifact
            ? (value) => {
                const artifact = value && typeof value === "object" && !Array.isArray(value)
                  ? (value as Record<string, unknown>)[artifactKey]
                  : undefined;
                const validation = params.validateArtifact!(artifactKey, artifact);
                return validation.errors.map((message) => ({ path: artifactKey, message }));
              }
            : undefined,
        });
        await params.onArtifact?.(artifactKey, output[artifactKey]);
        return [artifactKey, output[artifactKey]] as const;
      } catch (error) {
        waveAbort.abort();
        throw error;
      }
    }));
    params.signal?.removeEventListener("abort", abortParent);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    for (const result of results) {
      if (result.status === "fulfilled") {
        const [artifactKey, value] = result.value;
        artifacts[artifactKey] = value;
      }
    }
  }
  return artifacts;
}

export function makeValidationResult(errors: string[] = [], warnings: string[] = []): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}
