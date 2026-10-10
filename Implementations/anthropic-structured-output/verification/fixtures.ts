// Fixtures for the independent verification set. Separate from acceptance/: responses come from a
// queue, and schemas are walked by keyword position. No network, no database.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ModelEvent, ModelRequest } from "../../../src/lib/agent-harness/types";

export function wireModule(): { anthropicWireSchema: (schema: Record<string, unknown>) => { schema: any } | { unsupported: string } } {
  let mod: any;
  try {
    mod = require(resolve(__dirname, "../../../src/lib/agent-harness/providers/anthropic-schema"));
  } catch (error) {
    assert.fail(`providers/anthropic-schema.ts could not be loaded: ${(error as Error).message}`);
  }
  assert.equal(typeof mod?.anthropicWireSchema, "function", "anthropic-schema.ts exports anthropicWireSchema");
  return mod;
}

export const expressible = (result: unknown): Record<string, any> => {
  assert.ok(result && typeof result === "object" && "schema" in result, `expected { schema }, got ${JSON.stringify(result)?.slice(0, 300)}`);
  return (result as { schema: Record<string, any> }).schema;
};

export const unsupported = (result: unknown): string => {
  assert.ok(result && typeof result === "object" && "unsupported" in result, `expected { unsupported }, got ${JSON.stringify(result)?.slice(0, 300)}`);
  const reason = (result as { unsupported: unknown }).unsupported;
  assert.equal(typeof reason, "string");
  assert.ok((reason as string).length > 0, "the reason is not empty");
  return reason as string;
};

export const DIRECT_ENV = {
  RESEARCH_MODEL_BASE_URL: "https://api.anthropic.com/v1",
  RESEARCH_MODEL_ALLOWED_HOSTS: "api.anthropic.com",
  RESEARCH_MODEL_API_KEY: "verification-key",
  ANTHROPIC_API_KEY: undefined,
  RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT: undefined,
  RESEARCH_ALL_AGENTS_MODEL: "claude-haiku-5-5",
} as Record<string, string | undefined>;

export async function scopedEnv<T>(values: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]] as const));
  const set = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  for (const [key, value] of Object.entries(values)) set(key, value);
  try { return await body(); } finally { for (const [key, value] of saved) set(key, value); }
}

export interface Sent { url: string; text: string; json: any }

/** Answers fetch calls from a queue of [status, body] pairs; the last entry repeats. */
export async function queuedFetch<T>(queue: Array<[number, string]>, body: (sent: Sent[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const text = typeof init?.body === "string" ? init.body : "";
    sent.push({ url: String(input), text, json: text ? JSON.parse(text) : null });
    const [status, payload] = queue[Math.min(sent.length - 1, queue.length - 1)];
    return new Response(payload, { status, headers: { "content-type": status < 300 ? "text/event-stream" : "application/json" } });
  }) as typeof fetch;
  try { return await body(sent); } finally { globalThis.fetch = original; }
}

/** Anthropic SSE with the text split across two deltas and a ping in between. */
export function sse(text: string): string {
  const half = Math.ceil(text.length / 2);
  const events = [
    { type: "message_start", message: { id: "msg-verify", usage: { input_tokens: 11, cache_read_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, half) } },
    { type: "ping" },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(half) } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 13 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
}

export const apiError = (message: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });

export async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

export function request(model: string, outputSchema?: Record<string, unknown>): ModelRequest {
  return {
    model, system: "Verification instructions.", prompt: "Task packet:\n{\"case\":\"verification\"}", maxTokens: 512,
    agentName: "asset-analyst", ...(outputSchema ? { outputSchema } : {}),
  } as unknown as ModelRequest;
}

export const abort = () => new AbortController().signal;

const SCHEMA_MAPS = ["properties", "$defs", "definitions"];
const SCHEMA_LISTS = ["anyOf", "allOf", "oneOf"];

/** Visits every schema node (not property-name maps, enum values or defaults). */
export function eachSchema(node: unknown, visit: (schema: Record<string, any>, path: string) => void, path = "#"): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, any>;
  visit(schema, path);
  for (const key of SCHEMA_MAPS) {
    if (schema[key] && typeof schema[key] === "object") {
      for (const [name, child] of Object.entries(schema[key])) eachSchema(child, visit, `${path}/${key}/${name}`);
    }
  }
  for (const key of SCHEMA_LISTS) if (Array.isArray(schema[key])) schema[key].forEach((child: unknown, i: number) => eachSchema(child, visit, `${path}/${key}/${i}`));
  if (schema.items) eachSchema(schema.items, visit, `${path}/items`);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") eachSchema(schema.additionalProperties, visit, `${path}/additionalProperties`);
}
