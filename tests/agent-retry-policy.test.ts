import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, ResearchAgentRunError } from "../src/lib/agent-harness/errors";
import { FULL_TASK_REPAIR_CHARS, runResearchAgent } from "../src/lib/agent-harness/runner";
import { AnthropicCompatibleProvider } from "../src/lib/agent-harness/providers/anthropic-compatible";
import { OpenAICompatibleProvider } from "../src/lib/agent-harness/providers/openai-compatible";
import type { ModelEvent, ModelProvider, ModelRequest } from "../src/lib/agent-harness/types";

const classifierOutput = {
  selected_profile_key: "operating_company", selected_profile_name: "Operating Company", confidence: 0.9,
  asset_kind: "equity", identity_resolution: {}, required_modules: [], rejected_profiles: [],
  classification_evidence: [], ambiguities: [], recommended_next_tasks: [],
};

class ScriptedProvider implements ModelProvider {
  calls = 0;
  requests: ModelRequest[] = [];
  constructor(private readonly handler: (request: ModelRequest, call: number, signal: AbortSignal) => AsyncGenerator<ModelEvent>,
    readonly id = "scripted") {}
  stream(request: ModelRequest, signal: AbortSignal) {
    this.calls += 1;
    this.requests.push(request);
    return this.handler(request, this.calls, signal);
  }
}

async function* textResponse(text: string, finishReason = "stop", outputTokens = 20): AsyncGenerator<ModelEvent> {
  yield { type: "response.started", requestId: "req-test" };
  yield { type: "text.delta", text };
  yield { type: "usage", usage: { inputTokens: 10, outputTokens, costUsd: 0.01 } };
  yield { type: "response.completed", finishReason };
}

async function* failure(error: ProviderError): AsyncGenerator<ModelEvent> { throw error; }

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function withFetch<T>(reply: () => Response, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("an overloaded or 5xx provider is retried after the overload floor, and the fallback model gets its turn", async () => {
  await withEnv({ RESEARCH_ASSET_CLASSIFIER_FALLBACK_MODEL: "fallback-model", RESEARCH_ALL_AGENTS_MODEL: undefined }, async () => {
    const provider = new ScriptedProvider((_request, call) => call === 1
      ? failure(new ProviderError("Provider HTTP 529: overloaded_error", "server_error", { status: 529 }))
      : textResponse(JSON.stringify(classifierOutput)));
    const started = Date.now();
    const result = await runResearchAgent<any>({
      agentName: "asset-classifier", title: "overloaded", taskPacket: {}, provider,
      policy: { maxAttempts: 2, retryBaseDelayMs: 1, overloadRetryDelayMs: 120 },
    });
    assert.equal(result.attempts[0].errorCategory, "server_error");
    assert.equal(result.attempts[1].fallback, true);
    assert.equal(provider.requests[1].model, "fallback-model");
    assert.ok(Date.now() - started >= 100, "a 5xx waits for the overload floor, not the 1 ms base delay");
  });
});

test("a retry-after header sets the wait before the next attempt", async () => {
  const provider = new ScriptedProvider((_request, call) => call === 1
    ? failure(new ProviderError("Provider HTTP 503", "server_error", { status: 503, retryAfter: "0.15" }))
    : textResponse(JSON.stringify(classifierOutput)));
  const started = Date.now();
  await runResearchAgent({ agentName: "asset-classifier", title: "retry-after", taskPacket: {}, provider,
    policy: { maxAttempts: 2, retryBaseDelayMs: 1, overloadRetryDelayMs: 1 } });
  assert.ok(Date.now() - started >= 130);
});

test("a caller abort during the retry wait stops without another attempt", async () => {
  const provider = new ScriptedProvider(() => failure(new ProviderError("Provider HTTP 500", "server_error")));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "abort", taskPacket: {}, provider, signal: controller.signal,
    policy: { maxAttempts: 3, retryBaseDelayMs: 1, overloadRetryDelayMs: 10_000 } }),
  (error: any) => error instanceof ResearchAgentRunError && error.responseMetadata.error_type === "cancellation");
  assert.equal(provider.calls, 1);
});

test("Anthropic stream error events keep their type, and an OpenCode upstream 400 is a server error", async () => {
  const anthropic = new AnthropicCompatibleProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-key", allowedHosts: ["api.anthropic.com"] });
  const streamError = (type: string) => `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`
    + `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: "busy" } })}\n\n`;
  for (const [type, expected] of [["overloaded_error", "server_error"], ["api_error", "server_error"], ["rate_limit_error", "rate_limit"]]) {
    await withFetch(() => new Response(streamError(type), { status: 200 }), () => assert.rejects(
      collect(anthropic.stream({ model: "claude-haiku-5-5", prompt: "x", maxTokens: 10 }, new AbortController().signal)),
      (error: any) => error instanceof ProviderError && error.category === expected));
  }
  const upstream = JSON.stringify({ type: "error", error: { type: "server_error", message: "Upstream request failed: Model is unavailable" } });
  const openai = new OpenAICompatibleProvider({ mode: "direct", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "fixture-key", allowedHosts: ["opencode.ai"] });
  await withFetch(() => new Response(upstream, { status: 400 }), () => assert.rejects(
    collect(openai.stream({ model: "kimi-k2.7", prompt: "x" }, new AbortController().signal)),
    (error: any) => error instanceof ProviderError && error.category === "server_error"));
  await withFetch(() => new Response(upstream, { status: 400 }), () => assert.rejects(
    collect(anthropic.stream({ model: "qwen3.7-plus", prompt: "x", maxTokens: 10 }, new AbortController().signal)),
    (error: any) => error instanceof ProviderError && error.category === "server_error"));
});

test("output cut off at max_tokens is regenerated with twice the limit instead of repaired at the same limit", async () => {
  const provider = new ScriptedProvider((request, call) => call === 1
    ? textResponse('{"selected_profile_key":"operating_company","selected_profile_name":"Oper', "max_tokens", request.maxTokens)
    : textResponse(JSON.stringify(classifierOutput)));
  const result = await runResearchAgent<any>({ agentName: "asset-classifier", title: "truncated", taskPacket: {}, provider,
    policy: { maxAttempts: 2, retryBaseDelayMs: 1, maxOutputTokens: 1_000 } });
  assert.equal(provider.calls, 2, "no repair pass is sent for a truncated reply");
  assert.equal(result.attempts[0].errorCategory, "output_exhausted");
  assert.equal(result.attempts[0].repairAttempted, false);
  assert.deepEqual(provider.requests.map((request) => request.maxTokens), [1_000, 2_000]);
  assert.equal(result.structured.selected_profile_key, "operating_company");
});

test("the escalated output limit stays within the Claude model's documented cap", async () => {
  await withEnv({ RESEARCH_ALL_AGENTS_MODEL: "claude-haiku-5-5" }, async () => {
    const provider = new ScriptedProvider((request, call) => call === 1
      ? textResponse('{"selected_profile_key":"op', "max_tokens", request.maxTokens)
      : textResponse(JSON.stringify(classifierOutput)), "direct-anthropic-compatible");
    await runResearchAgent({ agentName: "asset-classifier", title: "cap", taskPacket: {}, provider,
      policy: { maxAttempts: 2, retryBaseDelayMs: 1, maxOutputTokens: 100_000 } });
    assert.deepEqual(provider.requests.map((request) => request.maxTokens), [100_000, 128_000]);
  });
});

test("output escalation stops once the model's cap is reached instead of resending the same request", async () => {
  await withEnv({ RESEARCH_ALL_AGENTS_MODEL: "claude-opus-5-5" }, async () => {
    const provider = new ScriptedProvider((request) => textResponse('{"selected_profile_key":"op', "max_tokens", request.maxTokens),
      "direct-anthropic-compatible");
    await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "cap stop", taskPacket: {}, provider,
      policy: { maxAttempts: 4, retryBaseDelayMs: 1, maxOutputTokens: 32_768 } }),
    (error: any) => error instanceof ResearchAgentRunError && error.responseMetadata.error_type === "output_exhausted");
    assert.deepEqual(provider.requests.map((request) => request.maxTokens), [32_768, 65_536, 128_000]);
  });
});

test("a model without a documented cap escalates no further than RESEARCH_UNKNOWN_MODEL_OUTPUT_CAP", async () => {
  await withEnv({ RESEARCH_ALL_AGENTS_MODEL: "some-open-model", RESEARCH_UNKNOWN_MODEL_OUTPUT_CAP: undefined }, async () => {
    const provider = new ScriptedProvider((request) => textResponse('{"selected_profile_key":"op', "length", request.maxTokens));
    await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "unknown cap", taskPacket: {}, provider,
      policy: { maxAttempts: 4, retryBaseDelayMs: 1, maxOutputTokens: 32_768 } }));
    assert.deepEqual(provider.requests.map((request) => request.maxTokens), [32_768, 65_536]);
  });
});

test("a prose answer that repair cannot fix is retried once, not on every attempt", async () => {
  await withEnv({ RESEARCH_ALL_AGENTS_MODEL: "prose-model" }, async () => {
    const provider = new ScriptedProvider(() => textResponse("I cannot produce JSON for this request."));
    await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "prose", taskPacket: {}, provider,
      policy: { maxAttempts: 4, retryBaseDelayMs: 1, maxRepairAttempts: 1 } }),
    (error: any) => error instanceof ResearchAgentRunError && error.attempts.length === 2
      && error.attempts.every((attempt: any) => attempt.errorCategory === "malformed_stream" && attempt.repairAttempted));
    assert.equal(provider.calls, 4, "two attempts of generation plus repair");
  });
});

test("a full-task repair prompt bounds the previous output and keeps its head and tail", async () => {
  const outputFormat = { requiredKeys: ["answer"], schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } };
  const provider = new ScriptedProvider((_request, call) => call === 1
    ? textResponse(`prose ${"y".repeat(FULL_TASK_REPAIR_CHARS)} late-field-123`)
    : textResponse(JSON.stringify({ answer: "ok" })));
  await runResearchAgent({ agentName: "asset-classifier", title: "truncate", taskPacket: {}, provider, outputFormat: outputFormat as any,
    policy: { maxAttempts: 1, maxRepairAttempts: 1 } });
  assert.equal(provider.calls, 2);
  const repair = provider.requests[1].prompt;
  assert.ok(repair.includes("Previous response: prose "));
  assert.ok(repair.includes("late-field-123"), "the tail of a long answer survives");
  assert.ok(/characters omitted/.test(repair) && !repair.includes("y".repeat(FULL_TASK_REPAIR_CHARS)), "the middle is cut");
});

test("an empty model setting fails fast instead of spinning", async () => {
  await withEnv({ RESEARCH_ALL_AGENTS_MODEL: "opencode-go/" }, async () => {
    const provider = new ScriptedProvider(() => textResponse(JSON.stringify(classifierOutput)));
    await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "empty", taskPacket: {}, provider }),
      (error: any) => error instanceof ProviderError && error.category === "invalid_request" && /No model configured/.test(error.message));
    await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "empty task", taskPacket: {}, provider,
      model: "''", fallbackModel: null }), /No model configured/);
    assert.equal(provider.calls, 0);
  });
});

test("built-in OpenCode fallback models are not sent to the Anthropic API", async () => {
  await withEnv({ RESEARCH_SOURCE_READER_FALLBACK_MODEL: undefined, RESEARCH_ALL_AGENTS_MODEL: undefined }, async () => {
    const run = async (providerId: string) => {
      const provider = new ScriptedProvider(() => failure(new ProviderError("fetch failed", "connection")), providerId);
      await assert.rejects(runResearchAgent({ agentName: "source-reader", title: "fallback", taskPacket: {}, provider,
        policy: { maxAttempts: 2, retryBaseDelayMs: 1 } }));
      return provider.requests.map((request) => request.model);
    };
    const primary = (await run("direct-anthropic-compatible"))[0];
    assert.deepEqual(await run("direct-anthropic-compatible"), [primary, primary]);
    assert.deepEqual(await run("opencode-go-direct"), [primary, "deepseek-v4-pro"]);
  });
});

test("a ledger failure after a successful call is not recorded as a failed attempt or retried", async () => {
  const provider = new ScriptedProvider(() => textResponse(JSON.stringify(classifierOutput)));
  const statuses: string[] = [];
  await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "ledger", taskPacket: {}, provider,
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    hooks: { onAttemptComplete: async (attempt) => { statuses.push(attempt.status); if (attempt.status === "success") throw new Error("ledger down"); } },
  }), /ledger down/);
  assert.deepEqual(statuses, ["success"]);
  assert.equal(provider.calls, 1);
});

test("the response size check counts each delta once", async () => {
  // Re-measuring the whole response on every delta made this quadratic: tens of seconds for 4 MB in 40,000 deltas.
  const chunk = "x".repeat(100);
  const provider = new ScriptedProvider(() => (async function* () {
    yield { type: "response.started" } as ModelEvent;
    for (let i = 0; i < 40_000; i += 1) yield { type: "text.delta", text: chunk } as ModelEvent;
    yield { type: "response.completed", finishReason: "stop" } as ModelEvent;
  })());
  const started = Date.now();
  await assert.rejects(runResearchAgent({ agentName: "asset-classifier", title: "bytes", taskPacket: {}, provider,
    policy: { maxAttempts: 1, maxRepairAttempts: 0, maxResponseBytes: 3_999_999 } }), /maximum size/);
  assert.ok(Date.now() - started < 3_000, `size check took ${Date.now() - started} ms`);
});
