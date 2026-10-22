/**
 * Per-task model, effort, output cap, timeout and budget reserve for research calls. A call site picks a tier by
 * passing `modelTier` ("premium", "mid" or "cheap") to callResearchAgent; this module turns the tier and the stage
 * key into the model and policy, and records what a run actually used (effective_config). A new stage call, such as
 * a framing call at the plan stage, adopts tiering by passing its modelTier; nothing else is needed.
 */
import { execFileSync } from "node:child_process";
import type postgres from "postgres";
import type { ExecutionPolicy } from "@/lib/agent-harness/types";
import { MODEL_TIERS, TIER_EFFORT, resolveTaskEffort, resolveTaskModel, type ResearchAgentName } from "@/lib/agent-harness/registry";
import { calculateCost } from "@/lib/agent-harness/telemetry";

type Sql = ReturnType<typeof postgres>;

/** Stages whose answers run past the 32,768 default (decision_synthesis hit it on Haiku, META 4fae0fb1): 65,536 from the start. */
export const LONG_OUTPUT_STAGES = new Set(["decision_synthesis", "operating_scenarios"]);
export const LONG_OUTPUT_TOKENS = 65_536;
const DEFAULT_OUTPUT_TOKENS = 32_768;

/**
 * Premium total timeout. Measured on META 4fae0fb1 (Haiku 5.5): 195-252 output tokens/s on the heavy calls
 * (operating_scenarios 48,103 tokens in 190.6 s; decision_synthesis 39,292 in 183 s). A frontier model at a quarter of
 * that speed (about 60 tokens/s) needs 65,536 / 60 x 1.1 = about 1,200 s for a full-cap answer. Override with
 * RESEARCH_PREMIUM_TIMEOUT_MS once a live premium run is measured.
 */
export const PREMIUM_TIMEOUT_MS = 1_200_000;

const positive = (name: string) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};
const isTier = (tier: string) => (MODEL_TIERS as readonly string[]).includes(tier);

export type TaskExecution = {
  tier: string; model: string; modelSource: string; fallbackModel?: string | null;
  effort?: ExecutionPolicy["effort"]; policy: Partial<ExecutionPolicy>; reserveUsd: number;
};

/**
 * One task's execution settings. The model follows resolveTaskModel's order (stage, tier, all-agents, agent, default);
 * effort follows resolveTaskEffort; long-output stages start at 65,536 output tokens; premium calls get the premium
 * timeout; the per-attempt budget reserve covers a full-cap answer plus a 100K-token prompt at the model's list price
 * (RESEARCH_<TIER>_ATTEMPT_BUDGET_RESERVE_USD overrides, RESEARCH_ATTEMPT_BUDGET_RESERVE_USD is the floor).
 */
export function taskExecution(input: { agentName: ResearchAgentName; modelTier: string; stageKey: string }): TaskExecution {
  const resolved = resolveTaskModel({ agentName: input.agentName, tier: input.modelTier, stageKey: input.stageKey });
  const effort = resolveTaskEffort({ tier: input.modelTier, stageKey: input.stageKey });
  const policy: Partial<ExecutionPolicy> = {
    ...(effort ? { effort } : {}),
    ...(LONG_OUTPUT_STAGES.has(input.stageKey) ? { maxOutputTokens: LONG_OUTPUT_TOKENS } : {}),
    ...(input.modelTier === "premium" ? { totalTimeoutMs: positive("RESEARCH_PREMIUM_TIMEOUT_MS") ?? PREMIUM_TIMEOUT_MS } : {}),
  };
  const outputLimit = policy.maxOutputTokens ?? positive("RESEARCH_MAX_OUTPUT_TOKENS") ?? DEFAULT_OUTPUT_TOKENS;
  const floor = positive("RESEARCH_ATTEMPT_BUDGET_RESERVE_USD") ?? 0.1;
  const tierReserve = isTier(input.modelTier) ? positive(`RESEARCH_${input.modelTier.toUpperCase()}_ATTEMPT_BUDGET_RESERVE_USD`) : undefined;
  const reserveUsd = tierReserve ?? Math.max(floor, Number(calculateCost(resolved.model, 100_000, outputLimit).toFixed(4)));
  return { tier: input.modelTier, model: resolved.model, modelSource: resolved.source,
    ...(resolved.fallbackModel !== undefined ? { fallbackModel: resolved.fallbackModel } : {}), effort, policy, reserveUsd };
}

/** Host only: the base URL's path and credentials are never recorded. */
const host = (url: string | undefined) => { try { return url ? new URL(url).host : null; } catch { return null; } };
let gitHead: string | null | undefined;
const head = () => {
  if (gitHead === undefined) {
    try { gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim() || null; }
    catch { gitHead = process.env.RESEARCH_GIT_SHA || null; }
  }
  return gitHead;
};

/** The executing process's research settings, allowlisted; never the environment itself. */
export function effectiveRunConfig() {
  const env = (name: string) => process.env[name] ?? null;
  return {
    provider: env("RESEARCH_MODEL_PROVIDER") ?? "direct-openai-compatible",
    base_url_host: host(process.env.RESEARCH_MODEL_BASE_URL),
    anthropic_structured_output: process.env.RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT !== "0",
    anthropic_effort: process.env.RESEARCH_ANTHROPIC_EFFORT !== "0",
    all_agents_model: env("RESEARCH_ALL_AGENTS_MODEL"),
    tier_models: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, env(`RESEARCH_${tier.toUpperCase()}_MODEL`)])),
    tier_efforts: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, env(`RESEARCH_${tier.toUpperCase()}_EFFORT`) ?? TIER_EFFORT[tier]])),
    stage_models: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^RESEARCH_STAGE_[A-Z0-9_]+_(MODEL|EFFORT)$/.test(key))),
    forecast_years_default: env("RESEARCH_FORECAST_YEARS"),
    agent_concurrency: env("RESEARCH_AGENT_CONCURRENCY"),
    evidence_passages_max: env("RESEARCH_EVIDENCE_PASSAGES_MAX"),
    evidence_target_max: env("RESEARCH_EVIDENCE_TARGET_MAX"),
    max_output_tokens: env("RESEARCH_MAX_OUTPUT_TOKENS"),
    agent_timeout_ms: env("RESEARCH_AGENT_TIMEOUT_MS"),
    premium_timeout_ms: positive("RESEARCH_PREMIUM_TIMEOUT_MS") ?? PREMIUM_TIMEOUT_MS,
    attempt_budget_reserve_usd: env("RESEARCH_ATTEMPT_BUDGET_RESERVE_USD"),
    git_head: head(),
  };
}

/**
 * Records the executing process's settings on the run (metadata_json.effective_config.run). A later job whose settings
 * differ keeps the earlier ones in effective_config.history, so a run that switched provider or model mid-way shows it.
 */
export async function recordEffectiveRunConfig(sql: Sql, runId: string) {
  const config = { ...effectiveRunConfig(), recorded_at: new Date().toISOString() };
  const [row] = await sql`SELECT metadata_json->'effective_config' AS config FROM research_runs WHERE id = ${runId}`;
  const prior = row?.config?.run as Record<string, unknown> | undefined;
  // jsonb reorders keys, so compare a canonical form.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  const same = prior && JSON.stringify(canonical({ ...prior, recorded_at: null })) === JSON.stringify(canonical({ ...config, recorded_at: null }));
  if (same) return;
  const history = [...(Array.isArray(row?.config?.history) ? row.config.history : []), ...(prior ? [prior] : [])].slice(-10);
  await sql`UPDATE research_runs SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('effective_config',
    COALESCE(metadata_json->'effective_config', '{}'::jsonb) || ${sql.json({ run: config, history } as any)}::jsonb)
    WHERE id = ${runId}`;
}

/**
 * Records one task type's model, tier, effort and limits (metadata_json.effective_config.tasks.<task_type>), in one
 * statement so parallel calls of a run never overwrite each other. models lists every model the task type has used.
 */
export async function recordEffectiveTaskConfig(sql: Sql, runId: string, taskType: string, execution: TaskExecution & { agentName: string }) {
  const entry = { agent: execution.agentName, tier: execution.tier, model: execution.model, model_source: execution.modelSource,
    effort: execution.effort ?? null, max_output_tokens: execution.policy.maxOutputTokens ?? null,
    total_timeout_ms: execution.policy.totalTimeoutMs ?? null, reserve_usd: execution.reserveUsd };
  await sql`UPDATE research_runs SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('effective_config',
    COALESCE(metadata_json->'effective_config', '{}'::jsonb) || jsonb_build_object('tasks',
      COALESCE(metadata_json->'effective_config'->'tasks', '{}'::jsonb) || jsonb_build_object(${taskType}::text,
        ${sql.json(entry as any)}::jsonb || jsonb_build_object('models', (
          SELECT COALESCE(jsonb_agg(DISTINCT m), '[]'::jsonb) FROM jsonb_array_elements_text(
            COALESCE(metadata_json->'effective_config'->'tasks'->${taskType}::text->'models', '[]'::jsonb) || to_jsonb(${execution.model}::text)) m)))))
    WHERE id = ${runId}`;
}
