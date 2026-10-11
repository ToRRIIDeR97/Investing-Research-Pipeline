// AC-1, AC-2, AC-3, AC-4 and AC-6 through provider.stream with a stubbed fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { MockProvider } from "../../../src/lib/agent-harness/providers/mock";
import { OpenCodeGoProvider } from "../../../src/lib/agent-harness/providers/opencode-go";
import { getProvider } from "../../../src/lib/agent-harness/providers/provider";
import {
  ANTHROPIC_ENV, anthropicSse, collect, errorBody, modelRequest, openAiSse, signal, smallSchema, textOf, withEnv, withFetch,
} from "./fixtures";

const ok = () => ({ text: anthropicSse('{"ok":true}') });

/** Raw request bodies for the same request with and without outputSchema, in that order. */
async function bodiesWithAndWithout(provider: { stream: (request: any, signal: AbortSignal) => AsyncIterable<any> }, schema: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  return withFetch((call) => ({ text: call.url.endsWith("/messages") ? anthropicSse('{"ok":true}') : openAiSse('{"ok":true}') }), async (calls) => {
    await collect(provider.stream(modelRequest({ ...fields, outputSchema: schema }), signal()));
    await collect(provider.stream(modelRequest(fields), signal()));
    return calls.map((call) => call.raw);
  });
}

test("AC-1: anthropic-direct sends output_config.format with the wire schema and leaves the rest of the body unchanged", async () => {
  await withEnv(ANTHROPIC_ENV, async () => {
    const schema = smallSchema("ac1_answer");
    await withFetch(ok, async (calls) => {
      const provider = getProvider("anthropic-direct");
      const events = await collect(provider.stream(modelRequest({ outputSchema: schema }), signal()));
      await collect(provider.stream(modelRequest(), signal()));
      assert.deepEqual(calls[0].body.output_config, {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { ac1_answer: { type: "string" }, score: { type: "number" } },
            required: ["ac1_answer", "score"],
            additionalProperties: false,
          },
        },
      });
      const { output_config: _sent, ...rest } = calls[0].body;
      assert.deepEqual(rest, calls[1].body, "model, system, messages, max_tokens and stream are unchanged");
      assert.equal(textOf(events), '{"ok":true}');
      const sent = events.find((event) => event.type === "request.sent");
      assert.ok(sent && sent.type === "request.sent" && JSON.parse(sent.body).output_config, "request.sent reports the body that carried output_config");
    });
  });
});

test("AC-2: an inexpressible schema leaves the request byte-for-byte as it is today", async () => {
  await withEnv(ANTHROPIC_ENV, async () => {
    const record = z.toJSONSchema(z.object({ values: z.record(z.string(), z.number()) }), { target: "draft-7", io: "input" }) as Record<string, unknown>;
    const [withSchema, without] = await bodiesWithAndWithout(getProvider("anthropic-direct"), record);
    assert.equal(withSchema, without);
    assert.ok(!withSchema.includes("output_config"));
  });
});

test("AC-3: OpenCode Go, the OpenAI-compatible provider and the mock never send output_config", async () => {
  const schema = smallSchema("ac3_answer");
  await withEnv({ ...ANTHROPIC_ENV, RESEARCH_MODEL_BASE_URL: "https://api.deepseek.com/v1", RESEARCH_MODEL_ALLOWED_HOSTS: "api.deepseek.com", RESEARCH_MODEL_API_KEY: "fixture-key" }, async () => {
    const opencode = new OpenCodeGoProvider("https://opencode.ai/zen/go/v1", "fixture-key", ["opencode.ai"]);
    for (const model of ["qwen3.7-plus", "deepseek-v4-flash"]) {
      const [withSchema, without] = await bodiesWithAndWithout(opencode, schema, { model });
      assert.equal(withSchema, without, `OpenCode Go ${model} body is unchanged`);
      assert.ok(!withSchema.includes("output_config"));
    }
    const [direct, directWithout] = await bodiesWithAndWithout(getProvider("direct-openai-compatible"), schema, { model: "deepseek-v4-flash" });
    assert.equal(direct, directWithout, "OpenAI-compatible body is unchanged");
  });
  const mock = new MockProvider();
  const request = { model: "mock", agentName: "asset-analyst", prompt: JSON.stringify({ output_contract: "team_brief", role: "business" }) };
  const withSchema = await collect(mock.stream(modelRequest({ ...request, system: undefined, outputSchema: schema }), signal()));
  const without = await collect(mock.stream(modelRequest({ ...request, system: undefined }), signal()));
  assert.deepEqual(withSchema, without, "mock output is unchanged");
});

test("AC-4: a schema rejection is retried once without output_config and the schema is remembered", async () => {
  await withEnv(ANTHROPIC_ENV, async () => {
    const rejected = smallSchema("ac4_rejected");
    const reply = (_call: unknown, index: number) => index === 0
      ? { status: 400, text: errorBody("output_config.format.schema: Schema is too complex for compilation. Simplify the schema.") }
      : { text: anthropicSse('{"ok":true}') };
    await withFetch(reply, async (calls) => {
      const outcome = await collect(getProvider("anthropic-direct").stream(modelRequest({ outputSchema: rejected }), signal()))
        .catch((error: unknown) => error);
      assert.ok(calls[0]?.body?.output_config, "the first request carries output_config");
      assert.ok(Array.isArray(outcome), `the stream completes instead of failing: ${outcome}`);
      assert.equal(calls.length, 2, "exactly one retry");
      const { output_config: _sent, ...first } = calls[0].body;
      assert.deepEqual(calls[1].body, first, "the retry is the same request without output_config");
      assert.equal(textOf(outcome as any[]), '{"ok":true}');
      assert.ok((outcome as any[]).some((event) => event.type === "response.completed"));

      // A later request with the same schema, from a new provider instance, sends no output_config.
      await collect(getProvider("anthropic-direct").stream(modelRequest({ outputSchema: structuredClone(rejected) }), signal()));
      assert.equal(calls.length, 3);
      assert.equal("output_config" in calls[2].body, false, "the rejected schema is remembered");

      // Other schemas are unaffected.
      await collect(getProvider("anthropic-direct").stream(modelRequest({ outputSchema: smallSchema("ac4_other") }), signal()));
      assert.ok(calls[3].body.output_config, "a different schema still sends output_config");
    });
  });
});

test("AC-6: RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT=0 turns structured output off", async () => {
  await withEnv({ ...ANTHROPIC_ENV, RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT: "0" }, async () => {
    const [withSchema, without] = await bodiesWithAndWithout(getProvider("anthropic-direct"), smallSchema("ac6_off"));
    assert.equal(withSchema, without);
    assert.ok(!withSchema.includes("output_config"));
  });
});

test("AC-6: with the switch unset, anthropic-direct sends output_config for Claude models", async () => {
  await withEnv(ANTHROPIC_ENV, async () => {
    const [withSchema] = await bodiesWithAndWithout(getProvider("anthropic-direct"), smallSchema("ac6_on"));
    assert.equal(JSON.parse(withSchema).output_config?.format?.type, "json_schema");
  });
});
