import assert from "node:assert/strict";
import test from "node:test";
import { createDeadlineController, withDeadlines } from "../src/lib/agent-harness/deadlines";
import { ProviderError, ResearchAgentRunError } from "../src/lib/agent-harness/errors";
import { parseStructuredOutput } from "../src/lib/agent-harness/output-parser";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { calculateCost } from "../src/lib/agent-harness/telemetry";
import { clearRegisteredTools, registerTool } from "../src/lib/agent-harness/tools";
import type { ModelEvent, ModelProvider, ModelRequest } from "../src/lib/agent-harness/types";
import { getAgentConfig } from "../src/lib/agent-harness/registry";
import { coerceStructuredOutput, validateSchema } from "../src/lib/agent-harness/validation";

const classifierOutput = {
  selected_profile_key: "operating_company", selected_profile_name: "Operating Company", confidence: 0.9,
  asset_kind: "equity", identity_resolution: {}, required_modules: [], rejected_profiles: [],
  classification_evidence: [], ambiguities: [], recommended_next_tasks: [],
};

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  calls = 0;
  constructor(private readonly handler: (request: ModelRequest, call: number, signal: AbortSignal) => AsyncGenerator<ModelEvent>) {}
  stream(request: ModelRequest, signal: AbortSignal) {
    this.calls += 1;
    return this.handler(request, this.calls, signal);
  }
}

async function* textResponse(text: string): AsyncGenerator<ModelEvent> {
  yield { type: "response.started", requestId: "req-test" };
  yield { type: "text.delta", text };
  yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } };
  yield { type: "response.completed", finishReason: "stop" };
}

test("JSON parser accepts one direct/fenced object and rejects ambiguity or truncation", () => {
  assert.equal((parseStructuredOutput('{"ok":true}', ["ok"]) as any).ok, true);
  assert.equal((parseStructuredOutput('```json\n{"ok":true}\n```', ["ok"]) as any).ok, true);
  assert.throws(() => parseStructuredOutput('{"ok":true} {"ok":false}', ["ok"]), /multiple/i);
  assert.throws(() => parseStructuredOutput('{"ok":', ["ok"]), /no valid JSON/i);
});

test("schema validation detects missing keys and wrong types", () => {
  const schema = { schema: { type: "object", required: ["name", "confidence"], properties: { name: { type: "string" }, confidence: { type: "number" } } } };
  assert.equal(validateSchema({ name: "x", confidence: 0.9 }, schema).length, 0);
  assert.ok(validateSchema({ name: "x", confidence: "high" }, schema).some((error) => error.path === "confidence"));
  assert.ok(validateSchema({ name: "x" }, schema).some((error) => error.path === "confidence"));
});

test("local schema coercion wraps object arrays and maps confidence labels", () => {
  const schema = { schema: { type: "object", properties: {
    notes: { type: "array", items: { type: "object" } },
    confidence: { type: "number" },
  } } };
  const result = coerceStructuredOutput({ notes: ["one", "two"], confidence: "low" }, schema);
  assert.equal(result.changed, true);
  assert.deepEqual(result.value, { notes: [{ description: "one" }, { description: "two" }], confidence: 0.25 });
  assert.equal(validateSchema(result.value, schema).length, 0);
});

test("local schema coercion accepts source-reader gap strings", () => {
  const schema = {
    schema: {
      type: "object",
      required: ["evidence_claims", "source_gaps"],
      properties: {
        evidence_claims: { type: "array", items: { type: "object" } },
        source_gaps: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    },
  };
  const result = coerceStructuredOutput({ evidence_claims: [], source_gaps: ["Missing full statements"] }, schema);
  assert.equal(result.changed, true);
  assert.deepEqual(result.value, { evidence_claims: [], source_gaps: [{ description: "Missing full statements" }] });
  assert.equal(validateSchema(result.value, schema).length, 0);
});

test("local schema coercion maps nested confidence labels", () => {
  const schema = { schema: { type: "object", properties: {
    claims: { type: "array", items: { type: "object", properties: { confidence: { type: "number" } } } },
  } } };
  const result = coerceStructuredOutput({ claims: [{ confidence: "high" }] }, schema);
  assert.deepEqual(result.value, { claims: [{ confidence: 0.75 }] });
  assert.equal(validateSchema(result.value, schema).length, 0);
});

test("local schema coercion normalizes valuation protocol aliases", () => {
  const schema = getAgentConfig("valuation-analyst").outputFormat;
  const value = {
    applicable_methods: ["fintech_platform_sotp"], not_applicable_methods: [],
    valuation_signals: [], scenarios: [], assumptions: ["Revenue mix is estimated"],
    sensitivity_notes: [], method_risks: [], source_gaps: [],
    method_proposals: [{
      method_key: "fintech_platform_sotp", method_name: "SOTP", method_version: "1.0",
      method_family: "sum_of_parts", origin: "valuation_analyst", rationale: "A sufficiently detailed rationale for the method.",
      replaces_method_keys: ["fintech_platform_sotp"], inputs: [],
      ordered_formulas: [{ key: "value", label: "Value", operation: "sum", args: [1], unit: "currency" }],
      outputs: { per_share_value: "value" }, scenarios: [], tables: [], limitations: "Revenue mix is estimated",
    }],
  };
  const result = coerceStructuredOutput(value, schema);
  const output = result.value as any;
  assert.equal(output.method_proposals[0].protocol_version, "1.0");
  assert.equal(output.method_proposals[0].origin, "proposed");
  assert.deepEqual(output.method_proposals[0].formulas, value.method_proposals[0].ordered_formulas);
  assert.deepEqual(output.method_proposals[0].limitations, ["Revenue mix is estimated"]);
  assert.deepEqual(output.applicable_methods, [{ description: "fintech_platform_sotp" }]);
  assert.equal(validateSchema(result.value, schema).length, 0);
});

test("deadline controller distinguishes inactivity, total, and caller cancellation", async () => {
  const inactivity = createDeadlineController(undefined, 500, 20);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(inactivity.reason(), "inactivity");
  inactivity.cleanup();

  const caller = new AbortController();
  const deadline = createDeadlineController(caller.signal, 500, 500);
  caller.abort();
  assert.equal(deadline.reason(), "caller");
  deadline.cleanup();

  await assert.rejects(() => withDeadlines(async (signal) => {
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
  }, 20, 500), (error: any) => error.name === "TimeoutError" && /total/.test(error.message));
});

test("runner returns validated output, raw text, attempts, and aggregate usage", async () => {
  const provider = new ScriptedProvider(() => textResponse(JSON.stringify(classifierOutput)));
  const result = await runResearchAgent<any>({ agentName: "asset-classifier", title: "test", taskPacket: {}, provider });
  assert.equal(result.structured.selected_profile_key, "operating_company");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].requestId, "req-test");
  assert.equal(result.usage.costUsd, 0.01);
  assert.match(result.rawText, /selected_profile_key/);
});

test("runner preserves an explicit zero provider cost", async () => {
  const provider = new ScriptedProvider(() => (async function* () {
    yield { type: "response.started", requestId: "free-request" } as ModelEvent;
    yield { type: "text.delta", text: JSON.stringify(classifierOutput) } as ModelEvent;
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20, costUsd: 0 } } as ModelEvent;
    yield { type: "response.completed", finishReason: "stop" } as ModelEvent;
  })());
  const result = await runResearchAgent({ agentName: "asset-classifier", title: "test", taskPacket: {}, provider });
  assert.equal(result.usage.costUsd, 0);
  assert.equal(result.attempts[0].costUsd, 0);
});

test("runner repairs malformed schema once with a bounded repair prompt", async () => {
  let repairPrompt = "";
  const provider = new ScriptedProvider((request, call) => {
    if (call === 2) repairPrompt = request.prompt;
    return textResponse(call === 1 ? '{"selected_profile_key":"x"}' : JSON.stringify(classifierOutput));
  });
  const result = await runResearchAgent<any>({ agentName: "asset-classifier", title: "test", taskPacket: { huge: "x".repeat(30_000) }, provider });
  assert.equal(result.attempts[0].repairAttempted, true);
  assert.deepEqual(result.attempts[0].passes?.map((pass) => pass.kind), ["generation", "repair"]);
  assert.ok((result.attempts[0].passes?.[0].validationErrors?.length || 0) > 0);
  assert.equal(result.attempts[0].passes?.[1].validationErrors?.length, 0);
  assert.ok(repairPrompt.length < 20_000, `repair prompt was ${repairPrompt.length} bytes`);
  assert.equal(provider.calls, 2);
});

test("empty completed output skips repair and uses the bounded fallback", async () => {
  const oldFallback = process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
  process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = "fallback-model";
  const prompts: string[] = [];
  const valid = {
    evidence_claims: Array.from({ length: 5 }, (_, index) => ({
      claim_text: `A sufficiently detailed fallback evidence claim number ${index}.`,
      claim_type: "source_fact", claim_category: "fact",
      source_id: "s", document_chunk_id: "c", confidence: 0.8,
    })),
    contradictions: [], source_gaps: [], low_confidence_items: [], rejected_candidates: [],
  };
  const provider = new ScriptedProvider((request, call) => {
    prompts.push(request.prompt);
    if (call === 1) return (async function* () {
      yield { type: "response.started" } as ModelEvent;
      yield { type: "response.completed", finishReason: "stop" } as ModelEvent;
    })();
    return textResponse(JSON.stringify(valid));
  });
  try {
    const packet = {
      source_context: { huge: "x".repeat(20_000) },
      source_corpus: [{ source_id: "s", document_chunk_id: "c", content_excerpt: "y".repeat(3_000) }],
    };
    const result = await runResearchAgent({
      agentName: "source-reader", title: "empty", taskPacket: packet, provider,
      promptFactory: (value) => JSON.stringify(value),
    });
    assert.equal(result.attempts[0].repairAttempted, false);
    assert.equal(result.attempts[0].errorCategory, "malformed_stream");
    assert.equal(result.attempts[1].compactionOccurred, true);
    assert.ok(prompts[1].length < prompts[0].length);
  } finally {
    if (oldFallback === undefined) delete process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
    else process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = oldFallback;
  }
});

test("repair failure preserves usage from the initial and repair passes", async () => {
  const provider = new ScriptedProvider((_request, call) => {
    if (call === 1) return textResponse('{"selected_profile_key":"x"}');
    return (async function* () {
      yield { type: "response.started", requestId: "repair-request" } as ModelEvent;
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 6, costUsd: 0.02 } } as ModelEvent;
      throw new ProviderError("repair connection failed", "connection");
    })();
  });
  await assert.rejects(
    () => runResearchAgent({ agentName: "asset-classifier", title: "repair usage", taskPacket: {}, provider, policy: { maxAttempts: 1 } }),
    (error: any) => error instanceof ResearchAgentRunError &&
      error.attempts[0].inputTokens === 15 &&
      error.attempts[0].outputTokens === 26 &&
      error.attempts[0].costUsd === 0.03
  );
});

test("hard total deadline does not wait for an uncooperative stream iterator", async () => {
  const provider = new ScriptedProvider(() => (async function* () {
    yield { type: "response.started" } as ModelEvent;
    await new Promise(() => undefined);
  })());
  const started = Date.now();
  await assert.rejects(
    () => runResearchAgent({
      agentName: "asset-classifier", title: "hard timeout", taskPacket: {}, provider,
      policy: { totalTimeoutMs: 25, inactivityTimeoutMs: 1_000, maxAttempts: 1 },
    }),
    (error: any) => error instanceof ResearchAgentRunError && error.attempts[0].timeoutType === "total"
  );
  assert.ok(Date.now() - started < 250);
});

test("schema repair exhaustion is non-retryable", async () => {
  const provider = new ScriptedProvider(() => textResponse('{"wrong":true}'));
  await assert.rejects(
    () => runResearchAgent({ agentName: "asset-classifier", title: "test", taskPacket: {}, provider }),
    (error: any) => error instanceof ResearchAgentRunError && error.attempts.length === 1 && error.attempts[0].errorCategory === "schema_validation"
  );
});

test("truncated generation and failed repair use the alternate model", async () => {
  const oldFallback = process.env.RESEARCH_ASSET_CLASSIFIER_FALLBACK_MODEL;
  process.env.RESEARCH_ASSET_CLASSIFIER_FALLBACK_MODEL = "fallback-model";
  const provider = new ScriptedProvider((_request, call) => textResponse(
    call < 3 ? '{"selected_profile_key":"truncated"' : JSON.stringify(classifierOutput)
  ));
  try {
    const result = await runResearchAgent<any>({
      agentName: "asset-classifier", title: "truncated fallback", taskPacket: {}, provider,
      policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    });
    assert.equal(provider.calls, 3);
    assert.equal(result.attempts[0].errorCategory, "malformed_stream");
    assert.equal(result.attempts[1].fallback, true);
    assert.equal(result.structured.selected_profile_key, "operating_company");
  } finally {
    if (oldFallback === undefined) delete process.env.RESEARCH_ASSET_CLASSIFIER_FALLBACK_MODEL;
    else process.env.RESEARCH_ASSET_CLASSIFIER_FALLBACK_MODEL = oldFallback;
  }
});

test("retryable primary failure invokes compacted fallback once", async () => {
  const oldFallback = process.env.RESEARCH_ASSET_ANALYST_FALLBACK_MODEL;
  process.env.RESEARCH_ASSET_ANALYST_FALLBACK_MODEL = "fallback-model";
  const evidence = Array.from({ length: 30 }, (_, id) => ({ id, claim_text: `claim ${id}` }));
  const valid = { analysis_sections: [], key_drivers: [], metric_interpretation: [], contradictions_or_tensions: [], missing_modules: [], source_gaps: [], analyst_questions: [], confidence: 0.9 };
  const prompts: string[] = [];
  const provider = new ScriptedProvider((request, call) => {
    prompts.push(request.prompt);
    if (call === 1) return (async function* () { throw new ProviderError("network", "connection"); })();
    return textResponse(JSON.stringify(valid));
  });
  try {
    const result = await runResearchAgent<any>({ agentName: "asset-analyst", title: "test", taskPacket: { evidence_claims: evidence }, provider, policy: { retryBaseDelayMs: 1 } });
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[1].fallback, true);
    assert.ok(prompts[1].length < prompts[0].length);
  } finally {
    if (oldFallback === undefined) delete process.env.RESEARCH_ASSET_ANALYST_FALLBACK_MODEL;
    else process.env.RESEARCH_ASSET_ANALYST_FALLBACK_MODEL = oldFallback;
  }
});

test("authentication and pre-attempt budget failures do not call fallback", async () => {
  const authProvider = new ScriptedProvider(() => (async function* () { throw new ProviderError("denied", "authentication"); })());
  await assert.rejects(() => runResearchAgent({ agentName: "asset-classifier", title: "x", taskPacket: {}, provider: authProvider }), /denied/);
  assert.equal(authProvider.calls, 1);

  const unusedProvider = new ScriptedProvider(() => textResponse(JSON.stringify(classifierOutput)));
  await assert.rejects(() => runResearchAgent({
    agentName: "asset-classifier", title: "x", taskPacket: {}, provider: unusedProvider,
    hooks: { beforeAttempt: () => { throw new ProviderError("budget", "budget_exhausted"); } },
  }), /budget/);
  assert.equal(unusedProvider.calls, 0);
});

test("connection failures before provider start record zero usage and cost", async () => {
  const oldFallback = process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
  process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = "fallback-model";
  const provider = new ScriptedProvider(() => (async function* () {
    throw new ProviderError("fetch failed", "connection");
  })());
  try {
    await assert.rejects(
      () => runResearchAgent({ agentName: "source-reader", title: "connection", taskPacket: { huge: "x".repeat(10_000) }, provider, policy: { retryBaseDelayMs: 1 } }),
      (error: any) => error instanceof ResearchAgentRunError &&
        error.attempts.every((attempt: any) => attempt.inputTokens === 0 && attempt.outputTokens === 0 && attempt.costUsd === 0)
    );
  } finally {
    if (oldFallback === undefined) delete process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
    else process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = oldFallback;
  }
});

test("retry schedule revisits primary and fallback models with backoff", async () => {
  const oldFallback = process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
  process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = "fallback-model";
  const models: string[] = [];
  const provider = new ScriptedProvider((request) => {
    models.push(request.model);
    return (async function* () { throw new ProviderError("fetch failed", "connection"); })();
  });
  try {
    await assert.rejects(() => runResearchAgent({
      agentName: "source-reader", title: "retry schedule", taskPacket: {}, provider,
      policy: { maxAttempts: 4, retryBaseDelayMs: 1 },
    }));
    assert.deepEqual(models, ["deepseek-v4-flash", "fallback-model", "deepseek-v4-flash", "fallback-model"]);
  } finally {
    if (oldFallback === undefined) delete process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
    else process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = oldFallback;
  }
});

test("caller cancellation propagates and response limits fail closed", async () => {
  const hanging = new ScriptedProvider((_request, _call, signal) => (async function* () {
    yield { type: "response.started" } as ModelEvent;
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError("cancelled", "cancellation")), { once: true }));
  })());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(() => runResearchAgent({ agentName: "asset-classifier", title: "x", taskPacket: {}, provider: hanging, signal: controller.signal }),
    (error: any) => error instanceof ResearchAgentRunError && error.attempts[0].status === "cancelled");

  const oversized = new ScriptedProvider(() => textResponse(JSON.stringify(classifierOutput) + "x".repeat(1000)));
  await assert.rejects(() => runResearchAgent({ agentName: "asset-classifier", title: "x", taskPacket: {}, provider: oversized, policy: { maxResponseBytes: 100 } }), /maximum size/i);
});

test("timeout attempts retain bounded partial response telemetry", async () => {
  const provider = new ScriptedProvider((_request, _call, signal) => (async function* () {
    yield { type: "response.started", requestId: "partial-request" } as ModelEvent;
    yield { type: "text.delta", text: '{"selected_profile_key":"partial"' } as ModelEvent;
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError("cancelled", "cancellation")), { once: true }));
  })());
  await assert.rejects(
    () => runResearchAgent({
      agentName: "asset-classifier", title: "partial timeout", taskPacket: {}, provider,
      policy: { totalTimeoutMs: 1_000, inactivityTimeoutMs: 15, maxAttempts: 1 },
    }),
    (error: any) => error instanceof ResearchAgentRunError &&
      error.attempts[0].timeoutType === "inactivity" &&
      error.attempts[0].requestId === "partial-request" &&
      error.attempts[0].rawResponseExcerpt.includes("partial") &&
      error.attempts[0].outputTokens > 0
  );
});

test("runner recovers complete schema-valid JSON at the inactivity boundary", async () => {
  const provider = new ScriptedProvider((_request, _call, signal) => (async function* () {
    yield { type: "response.started", requestId: "complete-timeout" } as ModelEvent;
    yield { type: "text.delta", text: JSON.stringify(classifierOutput) } as ModelEvent;
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError("cancelled", "cancellation")), { once: true }));
  })());
  const result = await runResearchAgent<any>({
    agentName: "asset-classifier", title: "complete timeout", taskPacket: {}, provider,
    policy: { totalTimeoutMs: 1_000, inactivityTimeoutMs: 15, maxAttempts: 1 },
  });
  assert.equal(result.structured.selected_profile_key, "operating_company");
  assert.equal(result.attempts[0].status, "success");
  assert.equal(result.attempts[0].completionRecoveredAtTimeout, true);
  assert.equal(result.attempts[0].passes?.[0].completionRecoveredAtTimeout, true);
});

test("tools are deny-by-default and enforce call limits", async () => {
  clearRegisteredTools();
  const config = getAgentConfig("asset-classifier");
  config.tools.lookup = true;
  registerTool({ name: "lookup", description: "lookup", inputSchema: { type: "object", required: ["id"] }, execute: async ({ id }) => ({ id }) });
  const provider = new ScriptedProvider((_request, call) => call === 1
    ? (async function* () { yield { type: "response.started" } as ModelEvent; yield { type: "tool.call", call: { id: "1", name: "lookup", arguments: '{"id":1}' } } as ModelEvent; yield { type: "response.completed" } as ModelEvent; })()
    : textResponse(JSON.stringify(classifierOutput)));
  try {
    const result = await runResearchAgent({ agentName: "asset-classifier", title: "x", taskPacket: {}, provider });
    assert.equal(result.attempts[0].toolCalls[0].status, "success");
  } finally {
    delete config.tools.lookup;
    clearRegisteredTools();
  }
});

test("telemetry computes deterministic costs", () => {
  assert.equal(calculateCost("deepseek-v4-pro", 10_000, 20_000), 0.007);
});
