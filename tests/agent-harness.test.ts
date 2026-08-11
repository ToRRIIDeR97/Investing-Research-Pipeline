import assert from "node:assert/strict";
import test from "node:test";
import { createDeadlineController, withDeadlines } from "../src/lib/agent-harness/deadlines";
import { ProviderError, ResearchAgentRunError } from "../src/lib/agent-harness/errors";
import { parseStructuredOutput } from "../src/lib/agent-harness/output-parser";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { calculateCost, estimateCost } from "../src/lib/agent-harness/telemetry";
import { clearRegisteredTools, registerTool } from "../src/lib/agent-harness/tools";
import type { ModelEvent, ModelProvider, ModelRequest } from "../src/lib/agent-harness/types";
import {
  AGENT_CONFIGS,
  DEFAULT_RESEARCH_MODEL,
  RESEARCH_AGENT_NAMES,
  getAgentConfig,
  resolveAgentModel,
} from "../src/lib/agent-harness/registry";
import { coerceStructuredOutput, validateSchema } from "../src/lib/agent-harness/validation";

const classifierOutput = {
  selected_profile_key: "operating_company", selected_profile_name: "Operating Company", confidence: 0.9,
  asset_kind: "equity", identity_resolution: {}, required_modules: [], rejected_profiles: [],
  classification_evidence: [], ambiguities: [], recommended_next_tasks: [],
};

test("model resolution is env-first and every registry default is DeepSeek V4 Flash", () => {
  const keys = [
    "RESEARCH_DEFAULT_MODEL",
    "RESEARCH_MID_MODEL",
    "RESEARCH_RESEARCH_ASSISTANT_MODEL",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const agentName of RESEARCH_AGENT_NAMES) {
      assert.equal(AGENT_CONFIGS[agentName].defaultModel, DEFAULT_RESEARCH_MODEL);
    }

    process.env.RESEARCH_DEFAULT_MODEL = DEFAULT_RESEARCH_MODEL;
    process.env.RESEARCH_MID_MODEL = "configured-mid-model";
    delete process.env.RESEARCH_RESEARCH_ASSISTANT_MODEL;
    assert.equal(resolveAgentModel("research-assistant"), "configured-mid-model");

    process.env.RESEARCH_RESEARCH_ASSISTANT_MODEL = "explicit-assistant-model";
    assert.equal(resolveAgentModel("research-assistant"), "explicit-assistant-model");

    delete process.env.RESEARCH_MID_MODEL;
    delete process.env.RESEARCH_RESEARCH_ASSISTANT_MODEL;
    assert.equal(resolveAgentModel("research-assistant"), DEFAULT_RESEARCH_MODEL);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("schema validation enforces bounds, finite numbers, and closed objects", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["label", "score", "items"],
    properties: {
      label: { type: "string", minLength: 3, maxLength: 5 },
      score: { type: "number", minimum: 0, maximum: 1 },
      items: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
    },
  };
  const errors = validateSchema({ label: "x", score: Number.NaN, items: ["a", "b", "c"], extra: true }, schema);
  assert.ok(errors.some((error) => error.path === "label" && error.message.includes("too short")));
  assert.ok(errors.some((error) => error.path === "score" && error.message.includes("Expected type")));
  assert.ok(errors.some((error) => error.path === "items" && error.message.includes("too many")));
  assert.ok(errors.some((error) => error.path === "extra" && error.message.includes("Additional")));
});

test("cost telemetry distinguishes provider, catalog, and unknown pricing", () => {
  assert.equal(estimateCost("deepseek-v4-pro", 1_000_000, 0).costSource, "catalog_estimate");
  assert.equal(estimateCost("unlisted-model", 1_000_000, 0).costSource, "unknown");
});

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

test("schema validation enforces enum and literal values", () => {
  const format = {
    schema: {
      type: "object",
      required: ["scenario_type", "artifact_type"],
      properties: {
        scenario_type: { type: "string", enum: ["bear", "base", "bull"] },
        artifact_type: { type: "string", const: "operating_scenario_set" },
      },
    },
  };
  assert.equal(validateSchema({
    scenario_type: "optimistic",
    artifact_type: "scenario",
  }, format).length, 2);
  assert.equal(validateSchema({
    scenario_type: "bull",
    artifact_type: "operating_scenario_set",
  }, format).length, 0);
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

test("local schema coercion accepts cited source-reader claim aliases", () => {
  const schema = getAgentConfig("source-reader").outputFormat;
  const value = {
    evidence_claims: Array.from({ length: 5 }, (_, index) => ({
      claim: `A sufficiently detailed claim alias number ${index} from a cited source.`,
      source_quote: "A sufficiently detailed supporting source quotation.",
      claim_type: "source_fact", claim_category: "fact", confidence: 0.8,
      source_id: "source-1", document_chunk_id: "chunk-1",
      char_start: 0, char_end: 100,
    })),
    contradictions: [], source_gaps: [], low_confidence_items: [], rejected_candidates: [],
  };
  const result = coerceStructuredOutput(value, schema);
  const claim = (result.value as any).evidence_claims[0];
  assert.equal(result.changed, true);
  assert.match(claim.claim_text, /claim alias number 0/);
  assert.equal(claim.quoted_text, "A sufficiently detailed supporting source quotation.");
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

test("provider queue wait pauses the total request deadline", async () => {
  const deadline = createDeadlineController(undefined, 30, 1_000);
  const before = deadline.remainingMs();
  deadline.pauseTotal();
  deadline.pauseInactivity();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(deadline.reason(), null);
  assert.ok(deadline.remainingMs() >= before - 5);
  deadline.resumeTotal();
  deadline.resumeInactivity();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(deadline.reason(), "total");
  deadline.cleanup();
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

test("source-reader requests omit max tokens unless explicitly configured", async () => {
  const previous = process.env.RESEARCH_SOURCE_READER_MAX_OUTPUT_TOKENS;
  delete process.env.RESEARCH_SOURCE_READER_MAX_OUTPUT_TOKENS;
  let maxTokens: number | undefined;
  const provider = new ScriptedProvider((request) => {
    maxTokens = request.maxTokens;
    return textResponse('{"ok":true}');
  });
  try {
    await runResearchAgent({
      agentName: "source-reader",
      title: "bounded source reader",
      taskPacket: {},
      provider,
      outputFormat: { requiredKeys: ["ok"], schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
      policy: { maxAttempts: 1 },
    });
    assert.equal(maxTokens, undefined);
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_SOURCE_READER_MAX_OUTPUT_TOKENS;
    else process.env.RESEARCH_SOURCE_READER_MAX_OUTPUT_TOKENS = previous;
  }
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
  assert.match(repairPrompt, /Required JSON schema:/);
  assert.match(repairPrompt, /Previous parsed response:/);
  assert.equal(provider.calls, 2);
});

test("runner honors multiple bounded repair attempts", async () => {
  const provider = new ScriptedProvider((_request, call) => textResponse(
    call < 3 ? '{"selected_profile_key":"x"}' : JSON.stringify(classifierOutput)
  ));
  const result = await runResearchAgent<any>({
    agentName: "asset-classifier", title: "two repairs", taskPacket: {}, provider,
    policy: { maxAttempts: 1, maxRepairAttempts: 2 },
  });
  assert.equal(provider.calls, 3);
  assert.deepEqual(result.attempts[0].passes?.map((pass) => pass.kind), ["generation", "repair", "repair"]);
});

test("domain validation participates in schema-aware repair", async () => {
  let repairPrompt = "";
  const provider = new ScriptedProvider((request, call) => {
    if (call === 2) repairPrompt = request.prompt;
    return textResponse(JSON.stringify(call === 1
      ? { ...classifierOutput, selected_profile_key: "unsupported" }
      : classifierOutput));
  });
  const result = await runResearchAgent<any>({
    agentName: "asset-classifier", title: "domain repair", taskPacket: {}, provider,
    validateStructured: (value) => (value as any).selected_profile_key === "operating_company"
      ? []
      : [{ path: "selected_profile_key", message: "Unsupported profile" }],
  });
  assert.equal(result.structured.selected_profile_key, "operating_company");
  assert.match(repairPrompt, /selected_profile_key: Unsupported profile/);
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
      quoted_text: "A sufficiently detailed source excerpt.", char_start: 0, char_end: 40,
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

test("schema repair exhaustion gets one bounded model retry", async () => {
  const provider = new ScriptedProvider(() => textResponse('{"wrong":true}'));
  await assert.rejects(
    () => runResearchAgent({ agentName: "asset-classifier", title: "test", taskPacket: {}, provider }),
    (error: any) => error instanceof ResearchAgentRunError &&
      error.attempts.length === 2 &&
      error.attempts.every((attempt: any) => attempt.errorCategory === "schema_validation")
  );
});

test("source-reader retries a citation schema failure with its fallback model", async () => {
  const oldFallback = process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
  process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = "fallback-model";
  let repairPrompt = "";
  const malformed = {
    evidence_claims: Array.from({ length: 5 }, (_, index) => ({
      claim: `A detailed but uncited founder-origin claim number ${index} from the source corpus.`,
      source_quote: "A source quote that needs a real source identifier.",
      confidence: 0.8,
    })),
    contradictions: [], source_gaps: [], low_confidence_items: [], rejected_candidates: [],
  };
  const valid = {
    evidence_claims: Array.from({ length: 5 }, (_, index) => ({
      claim_text: `A sufficiently detailed and cited source-reader claim number ${index}.`,
      claim_type: "source_fact", claim_category: "fact", confidence: 0.8,
      source_id: "source-1", document_chunk_id: "chunk-1",
      quoted_text: "A sufficiently detailed source excerpt used to repair a missing citation.",
      char_start: 0, char_end: 100,
    })),
    contradictions: [], source_gaps: [], low_confidence_items: [], rejected_candidates: [],
  };
  const provider = new ScriptedProvider((request, call) => {
    if (call === 2) repairPrompt = request.prompt;
    return textResponse(JSON.stringify(call < 3 ? malformed : valid));
  });
  try {
    const result = await runResearchAgent<any>({
      agentName: "source-reader",
      title: "source-reader schema fallback",
      taskPacket: {
        source_corpus: [{
          source_id: "source-1", document_chunk_id: "chunk-1", char_start: 0, char_end: 400,
          content_excerpt: "A sufficiently detailed source excerpt used to repair a missing citation.",
        }],
      },
      provider,
      policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    });
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].errorCategory, "schema_validation");
    assert.equal(result.attempts[1].fallback, true);
    assert.equal(result.attempts[1].model, "fallback-model");
    assert.match(repairPrompt, /source_id, document_chunk_id/);
    assert.match(repairPrompt, /"source_id":"source-1"/);
    assert.match(repairPrompt, /Do not use aliases such as claim or source_quote/);
  } finally {
    if (oldFallback === undefined) delete process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL;
    else process.env.RESEARCH_SOURCE_READER_FALLBACK_MODEL = oldFallback;
  }
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

test("source-reader has an agent-specific retry ceiling", async () => {
  const previous = process.env.RESEARCH_SOURCE_READER_MAX_MODEL_ATTEMPTS;
  process.env.RESEARCH_SOURCE_READER_MAX_MODEL_ATTEMPTS = "2";
  const provider = new ScriptedProvider(() => (async function* () {
    throw new ProviderError("fetch failed", "connection");
  })());
  try {
    await assert.rejects(() => runResearchAgent({
      agentName: "source-reader", title: "bounded retries", taskPacket: {}, provider,
      policy: { retryBaseDelayMs: 1 },
    }));
    assert.equal(provider.calls, 2);
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_SOURCE_READER_MAX_MODEL_ATTEMPTS;
    else process.env.RESEARCH_SOURCE_READER_MAX_MODEL_ATTEMPTS = previous;
  }
});

test("same-model source-reader retries compact the packet", async () => {
  const quote = "SoFi was founded by students seeking better access to financial services.";
  const packet = { source_corpus: [{ source_id: "s", document_chunk_id: "c", char_start: 0, char_end: 8_000, content_excerpt: `${quote}${" x".repeat(3_900)}` }] };
  const prompts: string[] = [];
  const provider = new ScriptedProvider((request, call) => {
    prompts.push(request.prompt);
    if (call === 1) return (async function* () { throw new ProviderError("stream ended", "malformed_stream"); })();
    return textResponse(JSON.stringify({
      evidence_claims: [{
        claim_text: quote,
        claim_type: "source_fact",
        claim_category: "fact",
        source_id: "s",
        document_chunk_id: "c",
        quoted_text: quote,
        char_start: 0,
        char_end: quote.length,
        confidence: 0.8,
      }],
      contradictions: [], source_gaps: [], low_confidence_items: [], rejected_candidates: [],
    }));
  });
  const result = await runResearchAgent({
    agentName: "source-reader", title: "compact retry", taskPacket: packet, provider,
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1].compactionOccurred, true);
  assert.ok(prompts[1].length < prompts[0].length);
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

test("runner recovers complete schema-valid JSON without a completion marker", async () => {
  const provider = new ScriptedProvider(() => (async function* () {
    yield { type: "response.started", requestId: "missing-marker" } as ModelEvent;
    yield { type: "text.delta", text: JSON.stringify(classifierOutput) } as ModelEvent;
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } } as ModelEvent;
  })());
  const result = await runResearchAgent<any>({
    agentName: "asset-classifier", title: "missing marker", taskPacket: {}, provider,
    policy: { maxAttempts: 1 },
  });
  assert.equal(result.structured.selected_profile_key, "operating_company");
  assert.equal(provider.calls, 1);
  assert.equal(result.attempts[0].status, "success");
  assert.equal(result.attempts[0].completionRecoveredWithoutMarker, true);
  assert.equal(result.attempts[0].passes?.[0].completionRecoveredWithoutMarker, true);
});

test("runner recovers schema-valid JSON when the provider terminates after the payload", async () => {
  const provider = new ScriptedProvider(() => (async function* () {
    yield { type: "response.started", requestId: "terminated-after-json" } as ModelEvent;
    yield { type: "text.delta", text: JSON.stringify(classifierOutput) } as ModelEvent;
    throw new ProviderError("Provider stream failed: terminated", "malformed_stream");
  })());
  const result = await runResearchAgent<any>({
    agentName: "asset-classifier", title: "terminated stream", taskPacket: {}, provider,
    policy: { maxAttempts: 1 },
  });
  assert.equal(result.structured.selected_profile_key, "operating_company");
  assert.equal(result.attempts[0].status, "success");
  assert.equal(result.attempts[0].completionRecoveredWithoutMarker, true);
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
