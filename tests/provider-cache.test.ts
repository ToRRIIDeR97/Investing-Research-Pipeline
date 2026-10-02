import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCacheMiss, deriveCacheAffinityId, observeWireRequest, promptMessages, stablePrefixHash, WireRequestTracker,
} from "../src/lib/agent-harness/cache";
import { AnthropicCompatibleProvider } from "../src/lib/agent-harness/providers/anthropic-compatible";
import { OpenAICompatibleProvider } from "../src/lib/agent-harness/providers/openai-compatible";
import { OpenCodeGoProvider } from "../src/lib/agent-harness/providers/opencode-go";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { calculateCost } from "../src/lib/agent-harness/telemetry";
import type { AgentOutputFormat, ModelEvent, ModelProvider, ModelRequest, ModelUsage } from "../src/lib/agent-harness/types";
import { exactJsonPrompt, runContextFirst } from "../src/lib/research/run-context";

const openAiStream = (usage: Record<string, unknown>) => [
  `data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"ok"}' }, finish_reason: "stop" }], usage })}`,
  "data: [DONE]",
].join("\n\n") + "\n\n";

const anthropicStream = (usage: Record<string, unknown>) => [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-1", usage } })}`,
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"answer\\":\\"ok\\"}"}}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n") + "\n\n";

async function withFetch<T>(respond: (url: string) => string, run: (calls: Array<{ url: string; headers: Headers; body: any }>) => Promise<T>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; body: any }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")) });
    return new Response(respond(url), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const usageOf = (events: ModelEvent[]) => Object.assign({}, ...events.flatMap(event => event.type === "usage" ? [event.usage] : []));

test("agent prompts split into stable instructions and the task packet", () => {
  const prompt = exactJsonPrompt({ agentName: "asset-classifier", requiredKeys: ["answer"], packet: { output_contract: "x", asset: { name: "A" } } });
  const messages = promptMessages(prompt);
  assert.match(messages.system || "", /^Run Research OS v3 agent: asset-classifier\./);
  assert.ok(!messages.system?.includes("Task packet:"));
  assert.match(messages.prompt, /^Task packet:\n\{"asset":/);
  assert.deepEqual(promptMessages("no marker here"), { prompt: "no marker here" });
});

test("run-wide packet context leads and call-specific fields keep their order", () => {
  const packet = { output_contract: "report_section", section_plan: { id: "s1" }, evidence_claims: [1], asset: { name: "A" } };
  assert.deepEqual(Object.keys(runContextFirst(packet)), ["asset", "evidence_claims", "output_contract", "section_plan"]);
  const ordered = { asset: {}, research_question: "q", other: 1 };
  assert.equal(runContextFirst(ordered), ordered);
});

test("cache affinity is stable within a scope and opaque to the provider", () => {
  const input = { scopeId: "run-123", providerId: "opencode-go-direct", modelId: "deepseek-v4-flash", stablePrefixHash: stablePrefixHash("rules") };
  const id = deriveCacheAffinityId(input);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, deriveCacheAffinityId({ ...input }));
  assert.notEqual(id, deriveCacheAffinityId({ ...input, scopeId: "run-456" }));
  assert.notEqual(id, deriveCacheAffinityId({ ...input, modelId: "deepseek-v4-pro" }));
  assert.notEqual(id, deriveCacheAffinityId({ ...input, stablePrefixHash: stablePrefixHash("other rules") }));
  assert.ok(!id.includes("run-123"));
  assert.throws(() => deriveCacheAffinityId({ ...input, scopeId: " " }), /must not be empty/);
});

test("wire observations separate the stable prefix from the dynamic tail without content", () => {
  const body = (task: string, temperature = 0.2) => JSON.stringify({ model: "m", messages: [
    { role: "system", content: "stable research rules" }, { role: "user", content: task },
  ], temperature, stream: true, max_tokens: 100 });
  const first = observeWireRequest(body("first packet"), { providerId: "p", modelId: "m", affinityId: "secret-affinity" });
  const second = observeWireRequest(body("second packet"), { providerId: "p", modelId: "m", affinityId: "secret-affinity" });
  const hotter = observeWireRequest(body("second packet", 0.9), { providerId: "p", modelId: "m", affinityId: "secret-affinity" });
  assert.equal(first.stablePrefixHash, second.stablePrefixHash);
  assert.notEqual(first.dynamicTailHash, second.dynamicTailHash);
  assert.notEqual(second.stablePrefixHash, hotter.stablePrefixHash);
  assert.doesNotMatch(JSON.stringify(first), /stable research rules|first packet|secret-affinity/);
  assert.equal(classifyCacheMiss(undefined, first, 0), "first-request");
  assert.equal(classifyCacheMiss({ observation: first, inFlight: false }, second, 64), "none");
  assert.equal(classifyCacheMiss({ observation: first, inFlight: false }, second, 0), "unexplained-provider-miss");
  assert.equal(classifyCacheMiss({ observation: first, inFlight: true }, second, 0), "previous-in-flight");
  assert.equal(classifyCacheMiss({ observation: second, inFlight: false }, hotter, 0), "prefix-changed");
  const other = observeWireRequest(body("second packet"), { providerId: "p", modelId: "m", affinityId: "other" });
  assert.equal(classifyCacheMiss({ observation: first, inFlight: false }, other, 0), "affinity-changed");
});

test("wire tracker compares with the previous request in the group and stays bounded", () => {
  const tracker = new WireRequestTracker(2);
  const observe = (payload: string) => observeWireRequest(payload, { providerId: "p", modelId: "m" });
  const a = JSON.stringify({ messages: [{ role: "user", content: "shared prefix then A" }] });
  const b = JSON.stringify({ messages: [{ role: "user", content: "shared prefix then B" }] });
  assert.equal(tracker.record("g", a, observe(a)).previous, undefined);
  const second = tracker.record("g", b, observe(b));
  assert.equal(second.previous?.inFlight, true);
  assert.equal(second.commonPrefixBytes, a.indexOf("A"));
  tracker.complete("g", observe(b).wireRequestHash);
  assert.equal(tracker.record("g", a, observe(a)).previous?.inFlight, false);
  tracker.record("h", a, observe(a));
  tracker.record("i", a, observe(a));
  assert.equal(tracker.record("g", a, observe(a)).previous, undefined, "oldest group was evicted");
});

test("cached prompt tokens are priced below uncached input", () => {
  assert.equal(calculateCost("deepseek-v4-pro", 10_000, 20_000), 0.007);
  assert.equal(calculateCost("deepseek-v4-pro", 10_000, 20_000, { cacheReadTokens: 8_000 }), 0.005992);
  assert.equal(calculateCost("deepseek-v4-pro", 10_000, 0, { cacheWriteTokens: 10_000 }), 0.00175);
  assert.equal(calculateCost("deepseek-v4-pro", 100, 0, { cacheReadTokens: 1_000 }), calculateCost("deepseek-v4-pro", 100, 0, { cacheReadTokens: 100 }));
});

test("OpenAI-compatible provider sends a system message and reads OpenAI and DeepSeek cache counts", async () => {
  const usages = [
    { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 64 } },
    { prompt_tokens: 100, completion_tokens: 3, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
    { prompt_tokens: 100, completion_tokens: 3 },
  ];
  let call = 0;
  await withFetch(() => openAiStream(usages[call++]), async (calls) => {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: "http://127.0.0.1:9/v1" });
    const request: ModelRequest = { model: "m", system: "rules", prompt: "Task packet:\n{}" };
    const first = await collect(provider.stream(request, new AbortController().signal));
    const second = await collect(provider.stream(request, new AbortController().signal));
    const third = await collect(provider.stream({ model: "m", prompt: "x" }, new AbortController().signal));
    assert.deepEqual(calls[0].body.messages, [{ role: "system", content: "rules" }, { role: "user", content: "Task packet:\n{}" }]);
    assert.deepEqual(calls[2].body.messages, [{ role: "user", content: "x" }]);
    const sent = first.find(event => event.type === "request.sent");
    assert.deepEqual(JSON.parse((sent as Extract<ModelEvent, { type: "request.sent" }>).body), calls[0].body);
    assert.equal(usageOf(first).cacheReadTokens, 64);
    assert.equal(usageOf(second).cacheReadTokens, 80);
    assert.equal(usageOf(third).cacheReadTokens, undefined, "absent counts stay unreported rather than zero");
  });
});

test("Anthropic-compatible provider marks the instructions cacheable and totals cache usage", async () => {
  await withFetch(() => anthropicStream({ input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 }), async (calls) => {
    const provider = new AnthropicCompatibleProvider({ baseUrl: "https://example.com/v1", apiKey: "k", allowedHosts: ["example.com"] });
    const events = await collect(provider.stream({ model: "qwen3.7-plus", system: "rules", prompt: "Task packet:\n{}" }, new AbortController().signal));
    assert.deepEqual(calls[0].body.system, [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(usageOf(events), { inputTokens: 100, cacheReadTokens: 70, cacheWriteTokens: 20, outputTokens: 3 });
    const prior = process.env.RESEARCH_ANTHROPIC_CACHE_CONTROL;
    process.env.RESEARCH_ANTHROPIC_CACHE_CONTROL = "0";
    try {
      await collect(provider.stream({ model: "qwen3.7-plus", system: "rules", prompt: "x" }, new AbortController().signal));
      assert.equal(calls[1].body.system, "rules");
    } finally {
      if (prior === undefined) delete process.env.RESEARCH_ANTHROPIC_CACHE_CONTROL;
      else process.env.RESEARCH_ANTHROPIC_CACHE_CONTROL = prior;
    }
  });
});

test("OpenCode Go keeps one session per affinity group across provider instances", async () => {
  await withFetch((url) => url.endsWith("/messages") ? anthropicStream({ input_tokens: 2 }) : openAiStream({ prompt_tokens: 2, completion_tokens: 3 }), async (calls) => {
    const make = () => new OpenCodeGoProvider("https://opencode.ai/zen/go/v1", "fixture-key", ["opencode.ai"]);
    const signal = new AbortController().signal;
    await collect(make().stream({ model: "deepseek-v4-flash", prompt: "x", cacheAffinityId: "a".repeat(64) }, signal));
    await collect(make().stream({ model: "deepseek-v4-flash", prompt: "y", cacheAffinityId: "a".repeat(64) }, signal));
    await collect(make().stream({ model: "qwen3.7-plus", prompt: "x", cacheAffinityId: "b".repeat(64) }, signal));
    const unscoped = make();
    await collect(unscoped.stream({ model: "glm-5.2", prompt: "x" }, signal));
    await collect(unscoped.stream({ model: "glm-5.2", prompt: "x" }, signal));
    const sessions = calls.map(call => call.headers.get("x-opencode-session"));
    assert.equal(sessions[0], "a".repeat(64));
    assert.equal(sessions[1], sessions[0]);
    assert.equal(sessions[2], "b".repeat(64));
    assert.ok(sessions[3] && sessions[3] === sessions[4], "requests without affinity keep the provider's own session");
  });
});

class RecordingProvider implements ModelProvider {
  readonly id = "recording";
  requests: ModelRequest[] = [];
  constructor(private readonly respond: (request: ModelRequest, call: number) => { text: string; usage: ModelUsage }) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const { text, usage } = this.respond(request, this.requests.length);
    yield { type: "request.sent", body: JSON.stringify({ model: request.model, messages: [
      ...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt },
    ] }) };
    yield { type: "response.started", requestId: `req-${this.requests.length}` };
    yield { type: "text.delta", text };
    yield { type: "usage", usage };
    yield { type: "response.completed", finishReason: "stop" };
  }
}

const answerFormat: AgentOutputFormat = {
  requiredKeys: ["answer"],
  schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
  validate: (value) => (value as { answer?: unknown })?.answer === "ok" ? [] : [{ path: "answer", message: "must be ok" }],
};

test("repair repeats the generation request as its prefix and records cache telemetry", async () => {
  const provider = new RecordingProvider((_request, call) => call === 1
    ? { text: '{"answer":"wrong"}', usage: { inputTokens: 1_000, outputTokens: 10 } }
    : { text: '{"answer":"ok"}', usage: { inputTokens: 1_100, outputTokens: 10, cacheReadTokens: 960 } });
  const packet = { output_contract: "answer", asset: { name: "Example" }, evidence_claims: [{ id: "e1", text: "x".repeat(2_000) }] };
  const result = await runResearchAgent<{ answer: string }>({
    agentName: "asset-classifier", title: "cache repair", taskPacket: packet, provider, outputFormat: answerFormat,
    cacheScope: `run-${Date.now()}`, policy: { maxAttempts: 1 },
    promptFactory: (p) => exactJsonPrompt({ agentName: "asset-classifier", requiredKeys: ["answer"], packet: p }),
  });
  assert.equal(result.structured.answer, "ok");
  const [generation, repair] = provider.requests;
  assert.ok(generation.system && generation.system === repair.system);
  assert.match(generation.prompt, /^Task packet:/);
  assert.ok(repair.prompt.startsWith(`${generation.prompt}\n\nREPAIR TASK: cache repair`));
  assert.ok(repair.prompt.includes('Previous response: {"answer":"wrong"}'));
  assert.ok(generation.cacheAffinityId && generation.cacheAffinityId === repair.cacheAffinityId);

  const [first, second] = result.attempts[0].passes!;
  assert.equal(first.cacheReadTokens, undefined);
  assert.equal(first.cache?.cacheUsageReported, false);
  assert.equal(second.cacheReadTokens, 960);
  assert.equal(second.cache?.cacheMissReason, "none");
  assert.ok((second.cache?.commonPrefixBytes || 0) > generation.prompt.length, "repair shares the whole generation request");
  assert.equal(result.attempts[0].cacheReadTokens, 960);
  assert.equal(result.usage.cacheReadTokens, 960);
  assert.ok(second.costUsd < calculateCost(result.attempts[0].model, 1_100, 10));
});

test("calls in the same scope with the same instructions share an affinity key", async () => {
  const provider = new RecordingProvider(() => ({ text: '{"answer":"ok"}', usage: { inputTokens: 10, outputTokens: 2 } }));
  const call = (scope: string, rules: string[]) => runResearchAgent({
    agentName: "asset-classifier", title: "affinity", taskPacket: { output_contract: "answer" }, provider, outputFormat: answerFormat,
    cacheScope: scope, policy: { maxAttempts: 1 },
    promptFactory: (p) => exactJsonPrompt({ agentName: "asset-classifier", requiredKeys: ["answer"], packet: p, extraRules: rules }),
  });
  await call("run-a", ["rule one"]);
  await call("run-a", ["rule one"]);
  await call("run-a", ["rule two"]);
  await call("run-b", ["rule one"]);
  const [first, same, otherRules, otherRun] = provider.requests.map(request => request.cacheAffinityId);
  assert.equal(first, same);
  assert.notEqual(first, otherRules);
  assert.notEqual(first, otherRun);
});
