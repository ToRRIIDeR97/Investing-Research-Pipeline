// Model tiering and effort: model precedence, effort per tier, per-task limits and reserves, and the request body each
// adapter sends. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskEffort, resolveTaskModel } from "../src/lib/agent-harness/registry";
import { AnthropicCompatibleProvider, supportsAdaptiveEffort } from "../src/lib/agent-harness/providers/anthropic-compatible";
import { OpenAICompatibleProvider } from "../src/lib/agent-harness/providers/openai-compatible";
import { OpenCodeGoProvider } from "../src/lib/agent-harness/providers/opencode-go";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import type { ModelEvent, ModelRequest } from "../src/lib/agent-harness/types";
import { LONG_OUTPUT_TOKENS, PREMIUM_TIMEOUT_MS, RESERVE_PROMPT_TOKENS, effectiveRunConfig, taskExecution } from "../src/lib/research/model-tiering";
import { decisionErrorsBlameThesis, runDecisionCalls } from "../src/lib/research/handlers/decision-synthesis";

const KEYS = ["RESEARCH_ALL_AGENTS_MODEL", "RESEARCH_ASSET_ANALYST_MODEL", "RESEARCH_PREMIUM_MODEL", "RESEARCH_MID_MODEL", "RESEARCH_CHEAP_MODEL",
  "RESEARCH_STAGE_DECISION_SYNTHESIS_MODEL", "RESEARCH_PREMIUM_FALLBACK_MODEL", "RESEARCH_STAGE_DECISION_SYNTHESIS_FALLBACK_MODEL",
  "RESEARCH_EFFORT", "RESEARCH_PREMIUM_EFFORT", "RESEARCH_STAGE_MOAT_ANALYSIS_EFFORT", "RESEARCH_PREMIUM_TIMEOUT_MS",
  "RESEARCH_ATTEMPT_BUDGET_RESERVE_USD", "RESEARCH_CHEAP_ATTEMPT_BUDGET_RESERVE_USD", "RESEARCH_MAX_OUTPUT_TOKENS"];
async function withEnv<T>(values: Record<string, string>, run: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return await run(); } finally {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

test("task model precedence: override, stage, tier, all agents, agent, default", async () => {
  const resolve = (tier = "premium", stageKey = "decision_synthesis", modelOverride?: string) =>
    resolveTaskModel({ agentName: "asset-analyst", tier, stageKey, modelOverride });
  await withEnv({}, () => {
    const untiered = resolve("mid", "moat_analysis");
    assert.equal(untiered.source, "default");
    assert.equal(untiered.fallbackModel, undefined, "the agent's own fallback rules apply");
  });
  await withEnv({ RESEARCH_ASSET_ANALYST_MODEL: "agent-model" }, () => assert.deepEqual(resolve(), { model: "agent-model", source: "agent" }));
  await withEnv({ RESEARCH_ASSET_ANALYST_MODEL: "agent-model", RESEARCH_ALL_AGENTS_MODEL: "claude-haiku-5-5" }, () =>
    assert.deepEqual(resolve(), { model: "claude-haiku-5-5", source: "all_agents" }));
  await withEnv({ RESEARCH_ALL_AGENTS_MODEL: "claude-haiku-5-5", RESEARCH_PREMIUM_MODEL: "claude-opus-5-5", RESEARCH_PREMIUM_FALLBACK_MODEL: "claude-sonnet-5-5" }, () => {
    assert.deepEqual(resolve(), { model: "claude-opus-5-5", source: "tier", fallbackModel: "claude-sonnet-5-5" });
    assert.equal(resolve("cheap").model, "claude-haiku-5-5", "a tier without its variable falls back to ALL");
    assert.equal(resolve("embedding").source, "all_agents", "non-model tiers are not tiers");
  });
  await withEnv({ RESEARCH_PREMIUM_MODEL: "claude-opus-5-5", RESEARCH_STAGE_DECISION_SYNTHESIS_MODEL: "claude-sonnet-5-5" }, () => {
    assert.deepEqual(resolve(), { model: "claude-sonnet-5-5", source: "stage", fallbackModel: null });
    assert.equal(resolve("premium", "decision_synthesis", "claude-haiku-5-5").model, "claude-haiku-5-5", "an explicit override wins");
  });
  // A stage model never inherits its tier's fallback; only its own stage fallback applies.
  await withEnv({ RESEARCH_STAGE_DECISION_SYNTHESIS_MODEL: "claude-sonnet-5-5", RESEARCH_PREMIUM_FALLBACK_MODEL: "claude-opus-5-5" }, () =>
    assert.equal(resolve().fallbackModel, null));
  await withEnv({ RESEARCH_STAGE_DECISION_SYNTHESIS_MODEL: "claude-sonnet-5-5", RESEARCH_PREMIUM_FALLBACK_MODEL: "claude-opus-5-5",
    RESEARCH_STAGE_DECISION_SYNTHESIS_FALLBACK_MODEL: "claude-haiku-5-5" }, () => assert.equal(resolve().fallbackModel, "claude-haiku-5-5"));
});

test("effort: stage, tier, global, then the tier default; 'default' sends none", async () => {
  await withEnv({}, () => {
    assert.deepEqual(["premium", "mid", "cheap"].map((tier) => resolveTaskEffort({ tier })), ["high", "medium", "low"]);
    assert.equal(resolveTaskEffort({ tier: "embedding" }), undefined);
  });
  await withEnv({ RESEARCH_EFFORT: "medium", RESEARCH_PREMIUM_EFFORT: "xhigh", RESEARCH_STAGE_MOAT_ANALYSIS_EFFORT: "max" }, () => {
    assert.equal(resolveTaskEffort({ tier: "premium", stageKey: "moat_analysis" }), "max");
    assert.equal(resolveTaskEffort({ tier: "premium", stageKey: "operating_model" }), "xhigh");
    assert.equal(resolveTaskEffort({ tier: "cheap" }), "medium");
  });
  await withEnv({ RESEARCH_PREMIUM_EFFORT: "default" }, () => assert.equal(resolveTaskEffort({ tier: "premium" }), undefined));
});

test("per-task limits: 65,536 output tokens for long stages, the premium timeout, and a reserve priced for the model", async () => {
  await withEnv({ RESEARCH_PREMIUM_MODEL: "claude-opus-5-5", RESEARCH_CHEAP_MODEL: "claude-haiku-5-5" }, () => {
    const decision = taskExecution({ agentName: "asset-analyst", modelTier: "premium", stageKey: "decision_synthesis" });
    assert.deepEqual(decision.policy, { effort: "high", maxOutputTokens: LONG_OUTPUT_TOKENS, totalTimeoutMs: PREMIUM_TIMEOUT_MS });
    // 100,001-token prompt at $4 + 65,536 output at $20 per MTok.
    assert.equal(decision.reserveUsd, Number((RESERVE_PROMPT_TOKENS * 4 / 1e6 + 65_536 * 20 / 1e6).toFixed(4)));
    const cheap = taskExecution({ agentName: "asset-analyst", modelTier: "cheap", stageKey: "team_requests" });
    assert.deepEqual(cheap.policy, { effort: "low" });
    // Haiku 5.5 above 100K prompt tokens bills $0.50/$2.50: 100,001 x 0.5 + 32,768 x 2.5 per MTok, above the $0.10 floor.
    assert.equal(cheap.reserveUsd, Number((RESERVE_PROMPT_TOKENS * 0.5 / 1e6 + 32_768 * 2.5 / 1e6).toFixed(4)));
    assert.ok(cheap.reserveUsd > 0.1);
    assert.equal(taskExecution({ agentName: "asset-analyst", modelTier: "mid", stageKey: "operating_scenarios" }).policy.maxOutputTokens, LONG_OUTPUT_TOKENS);
  });
  await withEnv({ RESEARCH_CHEAP_ATTEMPT_BUDGET_RESERVE_USD: "0.02", RESEARCH_PREMIUM_TIMEOUT_MS: "900000" }, () => {
    assert.equal(taskExecution({ agentName: "asset-analyst", modelTier: "cheap", stageKey: "team_answer" }).reserveUsd, 0.02);
    assert.equal(taskExecution({ agentName: "asset-analyst", modelTier: "premium", stageKey: "moat_analysis" }).policy.totalTimeoutMs, 900_000);
  });
});

test("the effective config records the provider host and settings, never keys or paths", async () => {
  await withEnv({ RESEARCH_PREMIUM_MODEL: "claude-opus-5-5" }, () => {
    const prior = { url: process.env.RESEARCH_MODEL_BASE_URL, key: process.env.RESEARCH_MODEL_API_KEY };
    process.env.RESEARCH_MODEL_BASE_URL = "https://user:secret@api.anthropic.com/v1?token=x";
    process.env.RESEARCH_MODEL_API_KEY = "sk-ant-secret";
    try {
      const config = effectiveRunConfig();
      assert.equal(config.base_url_host, "api.anthropic.com");
      assert.equal(config.tier_models.premium, "claude-opus-5-5");
      assert.equal(config.tier_efforts.premium, "high");
      assert.ok(!JSON.stringify(config).includes("secret"));
    } finally {
      if (prior.url === undefined) delete process.env.RESEARCH_MODEL_BASE_URL; else process.env.RESEARCH_MODEL_BASE_URL = prior.url;
      if (prior.key === undefined) delete process.env.RESEARCH_MODEL_API_KEY; else process.env.RESEARCH_MODEL_API_KEY = prior.key;
    }
  });
});

// ---------------------------------------------------------------- request bodies per adapter

const anthropicSse = [
  { type: "message_start", message: { id: "msg", usage: { input_tokens: 5 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "{\"answer\":\"ok\"}" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
const openaiSse = `data: ${JSON.stringify({ choices: [{ delta: { content: "{\"answer\":\"ok\"}" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`;

async function bodiesFor(run: () => Promise<unknown>, reply = anthropicSse) {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(reply, { status: 200 });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
  return bodies;
}
const drain = async (stream: AsyncIterable<ModelEvent>) => { let events = 0; for await (const event of stream) if (event) events += 1; return events; };
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
const request = (model: string, effort?: ModelRequest["effort"]): ModelRequest => ({ model, prompt: "Return JSON.", maxTokens: 512, outputSchema: schema, ...(effort ? { effort } : {}) });
const direct = (effort = true) => new AnthropicCompatibleProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-key", allowedHosts: ["api.anthropic.com"], structuredOutput: true, effort });

test("anthropic-direct sends output_config.effort with adaptive thinking, alongside the format, and never budget_tokens", async () => {
  const [body] = await bodiesFor(() => drain(direct().stream(request("claude-haiku-5-5", "low"), new AbortController().signal)));
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.max_tokens, 512);
  assert.ok(!JSON.stringify(body).includes("budget_tokens"));
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-4-6", "claude-fable-5-1"]) assert.ok(supportsAdaptiveEffort(model), model);
});

test("no effort or thinking without the option, without an effort, or for models that reject it", async () => {
  const signal = new AbortController().signal;
  const bodies = await bodiesFor(async () => {
    await drain(direct(false).stream(request("claude-opus-5-5", "high"), signal));
    await drain(direct().stream(request("claude-opus-5-5"), signal));
    await drain(direct().stream(request("claude-haiku-4-5", "high"), signal));
  });
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.equal("thinking" in body, false);
    assert.equal("effort" in (body.output_config ?? {}), false);
  }
});

test("OpenCode Go (DeepSeek through the OpenAI protocol, minimax through the Anthropic one) and OpenAI-compatible bodies carry no effort", async () => {
  const signal = new AbortController().signal;
  const go = new OpenCodeGoProvider("https://opencode.ai/zen/go/v1", "fixture-key", ["opencode.ai"]);
  const openai = new OpenAICompatibleProvider({ mode: "direct", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "fixture-key", allowedHosts: ["opencode.ai"] });
  const viaOpenAi = await bodiesFor(async () => {
    await drain(go.stream(request("deepseek-v4-pro", "high"), signal));
    await drain(openai.stream(request("deepseek-v4-pro", "high"), signal));
  }, openaiSse);
  const viaAnthropic = await bodiesFor(() => drain(go.stream(request("minimax-m3", "high"), signal)));
  for (const body of [...viaOpenAi, ...viaAnthropic]) {
    assert.ok(!/effort|thinking|reasoning_effort/.test(JSON.stringify(Object.keys(body))), JSON.stringify(Object.keys(body)));
    assert.equal(body.output_config?.effort, undefined);
  }
});

test("the runner passes the task model and the policy effort to the provider", async () => {
  await withEnv({}, async () => {
    const seen: ModelRequest[] = [];
    const provider = { id: "fixture", healthCheck: async () => ({ status: "healthy" as const }),
      async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
        seen.push(req);
        yield { type: "text.delta", text: "{\"answer\":\"ok\"}" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } };
        yield { type: "response.completed", finishReason: "stop" };
      } };
    await runResearchAgent({ agentName: "asset-analyst", title: "t", taskPacket: {}, prompt: "Return JSON.", provider,
      model: "claude-opus-5-5", fallbackModel: null, policy: { effort: "high", maxOutputTokens: 65_536 },
      outputFormat: { requiredKeys: ["answer"], validate: () => [] } });
    assert.equal(seen[0].model, "claude-opus-5-5");
    assert.equal(seen[0].effort, "high");
    assert.equal(seen[0].maxTokens, 65_536);
  });
});

test("a merged decision that fails on the cached thesis invalidates the thesis once and regenerates both calls", async () => {
  assert.equal(decisionErrorsBlameThesis([{ path: "investment_thesis.horizon" }]), true);
  assert.equal(decisionErrorsBlameThesis([{ path: "risk_register" }, { path: "catalyst_register.catalysts.0" }]), false);
  const log: string[] = [];
  let theses = 0, blamed = true;
  const raw = await runDecisionCalls({
    thesis: async () => { log.push("thesis"); theses += 1; return { investment_thesis: { version: theses } }; },
    registers: async (thesis: any) => {
      log.push(`registers:${thesis.investment_thesis.version}`);
      if (thesis.investment_thesis.version === 1) throw new Error("merged check failed");
      blamed = false;
      return { risk_register: { risks: [] } };
    },
    thesisBlamed: () => blamed,
    invalidateThesis: async () => { log.push("invalidate"); },
  });
  assert.deepEqual(log, ["thesis", "registers:1", "invalidate", "thesis", "registers:2"]);
  assert.deepEqual(raw, { investment_thesis: { version: 2 }, risk_register: { risks: [] } });
  // A failure the registers own propagates without touching the thesis, and a second thesis failure is not retried again.
  await assert.rejects(runDecisionCalls({ thesis: async () => ({}), registers: async () => { throw new Error("registers"); },
    thesisBlamed: () => false, invalidateThesis: async () => { throw new Error("must not invalidate"); } }), /registers/);
  let invalidations = 0;
  await assert.rejects(runDecisionCalls({ thesis: async () => ({}), registers: async () => { throw new Error("still failing"); },
    thesisBlamed: () => true, invalidateThesis: async () => { invalidations += 1; } }), /still failing/);
  assert.equal(invalidations, 1);
});
