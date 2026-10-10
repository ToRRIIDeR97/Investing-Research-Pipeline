// Structured output on anthropic-direct: wire schema edge cases, error mapping and pass telemetry. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../src/lib/agent-harness/errors";
import { AnthropicCompatibleProvider } from "../src/lib/agent-harness/providers/anthropic-compatible";
import { anthropicWireSchema } from "../src/lib/agent-harness/providers/anthropic-schema";
import { OpenCodeGoProvider } from "../src/lib/agent-harness/providers/opencode-go";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import type { ModelEvent, ModelRequest } from "../src/lib/agent-harness/types";

const sse = (text: string) => [
  { type: "message_start", message: { id: "msg", usage: { input_tokens: 5 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
const errorText = (message: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });

async function withFetch<T>(reply: (index: number) => { status?: number; text: string }, run: (bodies: any[]) => Promise<T>) {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const { status = 200, text } = reply(bodies.length - 1);
    return new Response(text, { status });
  }) as typeof fetch;
  try { return await run(bodies); } finally { globalThis.fetch = original; }
}

const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events; };
const direct = (structuredOutput = true) => new AnthropicCompatibleProvider({
  baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-key", allowedHosts: ["api.anthropic.com"], structuredOutput,
});
const schemaFor = (tag: string) => ({ type: "object", properties: { [tag]: { type: "string", maxLength: 10 } }, required: [tag] });
const request = (outputSchema: Record<string, unknown>, model = "claude-haiku-5-5"): ModelRequest => ({ model, prompt: "Return JSON.", maxTokens: 512, outputSchema });
const signal = () => new AbortController().signal;

test("wire schema: keyword-like property names, enum values and defaults are data", () => {
  const input = {
    type: "object",
    properties: {
      pattern: { type: "string", pattern: "^a" },
      format: { type: "string", format: "slug", default: { minLength: 3 } },
      mode: { enum: ["minimum", "maximum"] },
    },
    required: ["pattern", "format", "mode"],
  };
  const result = anthropicWireSchema(input);
  assert.deepEqual(result, { schema: {
    type: "object",
    properties: { pattern: { type: "string" }, format: { type: "string", default: { minLength: 3 } }, mode: { enum: ["minimum", "maximum"] } },
    required: ["pattern", "format", "mode"],
    additionalProperties: false,
  } });
  assert.deepEqual(anthropicWireSchema(input), result, "equal inputs give equal outputs");
});

test("wire schema: limits are inclusive, and definitions referenced without recursion are kept", () => {
  const optional = (n: number) => ({ type: "object", properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: "string" }])) });
  assert.ok("schema" in anthropicWireSchema(optional(24)));
  assert.ok("unsupported" in anthropicWireSchema(optional(25)));
  const unions = (n: number) => ({ type: "object", required: [], properties: Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [`u${i}`, i % 2 ? { type: ["string", "null"] } : { anyOf: [{ type: "number" }, { type: "null" }] }])) });
  assert.ok("schema" in anthropicWireSchema({ ...unions(16), required: Object.keys(unions(16).properties) }));
  assert.ok("unsupported" in anthropicWireSchema({ ...unions(17), required: Object.keys(unions(17).properties) }));
  const shared = anthropicWireSchema({
    type: "object", properties: { a: { $ref: "#/definitions/item" }, b: { $ref: "#/definitions/item" } }, required: ["a", "b"],
    definitions: { item: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  });
  assert.ok("schema" in shared && (shared.schema.definitions as any).item.additionalProperties === false);
  assert.ok("unsupported" in anthropicWireSchema({ type: "object", properties: { a: { $ref: "#/definitions/missing" } }, required: ["a"] }));
});

test("a context-length 400 keeps its mapping, sends no retry and does not disable the schema", async () => {
  const schema = schemaFor("context_case");
  await withFetch((index) => index === 0 ? { status: 400, text: errorText("prompt is too long: 250000 tokens > 200000 maximum") } : { text: sse("{}") }, async (bodies) => {
    const error = await collect(direct().stream(request(schema), signal())).catch((caught: unknown) => caught);
    assert.ok(error instanceof ProviderError && error.category === "context_limit", String(error));
    assert.equal(bodies.length, 1);
    await collect(direct().stream(request(schema), signal()));
    assert.ok(bodies[1].output_config, "the schema is not remembered as rejected");
  });
});

test("a rejection naming maxLength is a schema fallback, and a second rejection is mapped without another resend", async () => {
  await withFetch((index) => index === 0 ? { status: 400, text: errorText("output_config.format.schema: maxLength is not supported") } : { text: sse("{}") }, async (bodies) => {
    const events = await collect(direct().stream(request(schemaFor("max_length_case")), signal()));
    assert.equal(bodies.length, 2);
    assert.equal("output_config" in bodies[1], false);
    assert.deepEqual(events.filter((event) => event.type === "request.sent").map((event) => "output_config" in JSON.parse((event as any).body)), [true, false]);
  });
  await withFetch(() => ({ status: 400, text: errorText("Schema is too complex for compilation") }), async (bodies) => {
    const error = await collect(direct().stream(request(schemaFor("double_case")), signal())).catch((caught: unknown) => caught);
    assert.ok(error instanceof ProviderError && error.category === "invalid_request", String(error));
    assert.equal(bodies.length, 2, "one resend, then stop");
  });
});

test("no output_config without the option, for non-Claude models, or through OpenCode Go minimax", async () => {
  const schema = schemaFor("scope_case");
  await withFetch(() => ({ text: sse("{}") }), async (bodies) => {
    await collect(direct(false).stream(request(schema), signal()));
    await collect(direct().stream(request(schema, "qwen3.7-plus"), signal()));
    await collect(new OpenCodeGoProvider("https://opencode.ai/zen/go/v1", "fixture-key", ["opencode.ai"]).stream(request(schema, "minimax-m3"), signal()));
    assert.equal(bodies.length, 3);
    for (const body of bodies) assert.equal("output_config" in body, false);
  });
});

test("a failed pass still records structured-output telemetry", async () => {
  const outputFormat = { requiredKeys: ["answer"], schema: schemaFor("answer"), validate: () => [] };
  const prior = process.env.RESEARCH_ALL_AGENTS_MODEL;
  process.env.RESEARCH_ALL_AGENTS_MODEL = "claude-haiku-5-5";
  try {
    await withFetch((index) => index === 0
      ? { status: 400, text: errorText("Schema is too complex for compilation") }
      : { status: 401, text: errorText("invalid x-api-key") }, async () => {
      const error = await runResearchAgent({ agentName: "asset-analyst", title: "telemetry failure", taskPacket: {}, outputFormat,
        provider: direct(), policy: { maxAttempts: 1, maxRepairAttempts: 0 } }).catch((caught: unknown) => caught as any);
      assert.deepEqual(error.attempts[0].passes[0].structuredOutput, { sent: true, fallback: true });
      assert.equal(error.attempts[0].passes[0].errorCategory, "authentication");
    });
  } finally {
    if (prior === undefined) delete process.env.RESEARCH_ALL_AGENTS_MODEL;
    else process.env.RESEARCH_ALL_AGENTS_MODEL = prior;
  }
});
