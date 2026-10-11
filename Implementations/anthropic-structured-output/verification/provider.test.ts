// Independent provider checks: fallback boundaries (AC-4), scope (AC-3), the switch (AC-6), Claude-only (AC-1).
import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../../../src/lib/agent-harness/errors";
import { AnthropicCompatibleProvider } from "../../../src/lib/agent-harness/providers/anthropic-compatible";
import { OpenCodeGoProvider } from "../../../src/lib/agent-harness/providers/opencode-go";
import { getProvider } from "../../../src/lib/agent-harness/providers/provider";
import { abort, apiError, DIRECT_ENV, drain, queuedFetch, request, scopedEnv, sse } from "./fixtures";

const CLAUDE = "claude-haiku-5-5";
const OK = sse('{"verdict":"pass"}');
const schema = (field: string) => ({
  type: "object",
  properties: { [field]: { type: "string", enum: ["pass", "fail"] }, notes: { type: "array", maxItems: 3, items: { type: "string", maxLength: 80 } } },
  required: [field],
});

test("AC-4: a rejection naming an unsupported keyword is retried, not reported as a context limit", async () => {
  await scopedEnv(DIRECT_ENV, async () => {
    // "maxLength" matches the context-limit pattern /context|token|length/ used for other 400s.
    const rejection = apiError("output_config.format.schema: For 'string' type, property 'maxLength' is not supported");
    await queuedFetch([[400, rejection], [200, OK]], async (sent) => {
      const outcome = await drain(getProvider("anthropic-direct").stream(request(CLAUDE, schema("v4_maxlength")), abort())).catch((error) => error);
      assert.ok(sent[0].json.output_config, "the first request was structured");
      assert.ok(!(outcome instanceof Error), `the pass recovers instead of failing: ${outcome}`);
      const events = outcome as Awaited<ReturnType<typeof drain>>;
      assert.equal(sent.length, 2);
      assert.ok(!("output_config" in sent[1].json));
      const bodies = events.flatMap((event) => event.type === "request.sent" ? [JSON.parse(event.body)] : []);
      assert.equal(bodies.length, 2, "each body sent is reported by its own request.sent event");
      assert.ok(bodies[0].output_config && !("output_config" in bodies[1]), "the last request.sent is the body that was answered");
      assert.equal(events.at(-1)?.type, "response.completed");
    });
  });
});

test("AC-4: the remembered rejection outlives the provider instance and matches by content", async () => {
  await scopedEnv(DIRECT_ENV, async () => {
    const rejected = schema("v4_memory");
    await queuedFetch([[400, apiError("Schema is too complex for compilation")], [200, OK]], async (sent) => {
      const first = await drain(getProvider("anthropic-direct").stream(request(CLAUDE, rejected), abort())).catch((error) => error);
      assert.ok(sent[0].json.output_config, "the first request was structured");
      assert.ok(!(first instanceof Error), `the pass recovers: ${first}`);
      assert.equal(sent.length, 2);
      const again = getProvider("anthropic-direct");
      await drain(again.stream(request(CLAUDE, JSON.parse(JSON.stringify(rejected))), abort()));
      await drain(again.stream(request(CLAUDE, JSON.parse(JSON.stringify(rejected))), abort()));
      assert.equal(sent.length, 4, "no further rejected attempts");
      assert.ok(!("output_config" in sent[2].json) && !("output_config" in sent[3].json));
      await drain(again.stream(request(CLAUDE, schema("v4_memory_sibling")), abort()));
      assert.ok(sent[4].json.output_config, "a sibling schema is still structured");
    });
  });
});

test("AC-4: a context-limit 400 on a structured request is not a schema rejection", async () => {
  await scopedEnv(DIRECT_ENV, async () => {
    const tooLong = apiError("prompt is too long: 1048576 tokens > 1000000 maximum");
    await queuedFetch([[400, tooLong], [200, OK]], async (sent) => {
      const failure = await drain(getProvider("anthropic-direct").stream(request(CLAUDE, schema("v4_context")), abort())).then(() => null, (error) => error);
      assert.ok(sent[0].json.output_config, "the request was structured");
      assert.ok(failure instanceof ProviderError, `expected a ProviderError, got ${failure}`);
      assert.equal((failure as ProviderError).category, "context_limit");
      assert.equal(sent.length, 1, "no retry");
      await drain(getProvider("anthropic-direct").stream(request(CLAUDE, schema("v4_context")), abort()));
      assert.ok(sent[1].json.output_config, "the schema was not remembered as unsupported");
    });
  });
});

test("AC-4: the fallback happens once; a second rejection fails the pass as an invalid request", async () => {
  await scopedEnv(DIRECT_ENV, async () => {
    await queuedFetch([[400, apiError("Schema is too complex for compilation")]], async (sent) => {
      const failure = await drain(getProvider("anthropic-direct").stream(request(CLAUDE, schema("v4_twice")), abort())).then(() => null, (error) => error);
      assert.equal(sent.length, 2, "one retry, then stop");
      assert.ok(failure instanceof ProviderError);
      assert.equal((failure as ProviderError).category, "invalid_request");
    });
  });
});

test("AC-4 and AC-6: with the switch off, a 400 that mentions a schema is not retried", async () => {
  await scopedEnv({ ...DIRECT_ENV, RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT: "0" }, async () => {
    await queuedFetch([[400, apiError("output_config.format.schema: Schema is too complex for compilation")], [200, OK]], async (sent) => {
      const failure = await drain(getProvider("anthropic-direct").stream(request(CLAUDE, schema("v4_off")), abort())).then(() => null, (error) => error);
      assert.ok(failure instanceof ProviderError);
      assert.equal(sent.length, 1);
      assert.equal("output_config" in sent[0].json, false);
    });
  });
});

test("AC-6: the switch is on when unset or 1 and off only for 0", async () => {
  for (const [value, expected] of [[undefined, true], ["1", true], ["0", false]] as const) {
    await scopedEnv({ ...DIRECT_ENV, RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT: value }, async () => {
      await queuedFetch([[200, OK]], async (sent) => {
        const provider = getProvider("anthropic-direct");
        await drain(provider.stream(request(CLAUDE, schema(`v6_${value ?? "unset"}`)), abort()));
        await drain(provider.stream(request(CLAUDE), abort()));
        assert.equal("output_config" in sent[0].json, expected, `RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT=${value}`);
        if (!expected) assert.equal(sent[0].text, sent[1].text, "off means the body is unchanged");
      });
    });
  }
});

test("AC-1 and AC-3: only anthropic-direct with a Claude model and a schema gets output_config", async () => {
  await scopedEnv(DIRECT_ENV, async () => {
    await queuedFetch([[200, OK]], async (sent) => {
      const direct = getProvider("anthropic-direct");
      await drain(direct.stream(request("qwen3.7-plus", schema("v3_qwen")), abort()));
      await drain(direct.stream(request(CLAUDE), abort()));
      const plain = new AnthropicCompatibleProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "verification-key", allowedHosts: ["api.anthropic.com"] });
      await drain(plain.stream(request(CLAUDE, schema("v3_plain")), abort()));
      const opencode = new OpenCodeGoProvider("https://opencode.ai/zen/go/v1", "verification-key", ["opencode.ai"]);
      await drain(opencode.stream(request("minimax-m2.7", schema("v3_minimax")), abort()));
      assert.equal(sent.length, 4);
      sent.forEach((call, i) => assert.ok(!call.text.includes("output_config"), `request ${i} (${call.json.model}) has no output_config`));
      assert.ok(sent[3].url.endsWith("/messages"), "the OpenCode Go request went through the Anthropic protocol");
    });
  });
});
