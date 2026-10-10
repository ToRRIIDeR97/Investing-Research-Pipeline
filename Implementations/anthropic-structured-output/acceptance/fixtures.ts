// Fixtures for the anthropic-structured-output acceptance tests.
// No network: every test stubs globalThis.fetch. No database.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ModelEvent, ModelRequest } from "../../../src/lib/agent-harness/types";

export type WireResult = { schema: Record<string, any> } | { unsupported: string };

/** The wire-schema module is new. Load it lazily so a missing module or export fails the test, not the file. */
export function loadWireSchema(): (schema: Record<string, unknown>) => WireResult {
  let mod: any;
  try {
    mod = require(resolve(__dirname, "../../../src/lib/agent-harness/providers/anthropic-schema"));
  } catch (error) {
    assert.fail(`src/lib/agent-harness/providers/anthropic-schema.ts is missing or failed to load: ${(error as Error).message}`);
  }
  if (typeof mod.anthropicWireSchema !== "function") assert.fail("anthropic-schema.ts must export anthropicWireSchema(schema)");
  return mod.anthropicWireSchema;
}

/** Environment for getProvider("anthropic-direct"). The switch is unset, so it is on by default. */
export const ANTHROPIC_ENV: Record<string, string | undefined> = {
  RESEARCH_MODEL_BASE_URL: "https://api.anthropic.com/v1",
  RESEARCH_MODEL_ALLOWED_HOSTS: "api.anthropic.com",
  ANTHROPIC_API_KEY: "fixture-key",
  RESEARCH_MODEL_API_KEY: undefined,
  RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT: undefined,
};

export async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const prior = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try { return await run(); } finally { apply(prior); }
}

export interface FetchCall { url: string; raw: string; body: any }
export interface Reply { status?: number; text: string }

/** Replaces fetch for the duration of run; reply decides each response from the call and its index. */
export async function withFetch<T>(reply: (call: FetchCall, index: number) => Reply, run: (calls: FetchCall[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    const call = { url: String(input), raw, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    const { status = 200, text } = reply(call, calls.length - 1);
    return new Response(text, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
  }) as typeof fetch;
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

/** A complete Anthropic Messages SSE stream that returns text. */
export function anthropicSse(text: string): string {
  return [
    { type: "message_start", message: { id: "msg-fixture", usage: { input_tokens: 5 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
}

/** A complete OpenAI-compatible SSE stream that returns text. */
export function openAiSse(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
}

/** An Anthropic 400 error body. */
export const errorBody = (message: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });

export async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export const textOf = (events: ModelEvent[]) => events.map((event) => event.type === "text.delta" ? event.text : "").join("");

/** A provider request. outputSchema is the new optional ModelRequest field. */
export function modelRequest(fields: Record<string, unknown> = {}): ModelRequest {
  return { model: "claude-haiku-5-5", system: "Return one JSON object.", prompt: "Task packet:\n{\"asset\":\"Example\"}", maxTokens: 2048, ...fields } as unknown as ModelRequest;
}

export const signal = () => new AbortController().signal;

/** A small expressible schema; the tag keeps schemas distinct, because rejected schemas are remembered per process. */
export function smallSchema(tag: string): Record<string, unknown> {
  return {
    type: "object",
    properties: { [tag]: { type: "string", minLength: 1 }, score: { type: "number", minimum: 0, maximum: 1 } },
    required: [tag, "score"],
  };
}
