import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "../src/lib/agent-harness/errors";
import { isLatestAlias, modelTokens, parseModelList, pickLatest } from "../src/lib/agent-harness/model-family";
import { clearModelListCache, providerModels, resolveModel, resolveModels } from "../src/lib/agent-harness/latest-model";
import { AnthropicCompatibleProvider } from "../src/lib/agent-harness/providers/anthropic-compatible";
import { OpenCodeGoProvider } from "../src/lib/agent-harness/providers/opencode-go";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { calculateCost, familyPricedModel } from "../src/lib/agent-harness/telemetry";
import type { ModelEvent, ModelProvider, ModelRequest } from "../src/lib/agent-harness/types";

const ids = (...names: string[]) => names.map((id) => ({ id }));

test("model IDs split into family words and a version, ignoring snapshot dates and v/k prefixes", () => {
  assert.deepEqual(modelTokens("claude-haiku-4-5-20251001"), { words: ["claude", "haiku"], version: [4, 5] });
  assert.deepEqual(modelTokens("deepseek-v4.1-flash"), { words: ["deepseek", "flash"], version: [4, 1] });
  assert.deepEqual(modelTokens("qwen3.7-plus"), { words: ["qwen", "plus"], version: [3, 7] });
  assert.deepEqual(modelTokens("kimi-k2.7-code"), { words: ["kimi", "code"], version: [2, 7] });
  assert.equal(isLatestAlias("latest:haiku"), true);
  assert.equal(isLatestAlias(" Latest: Deepseek-Flash "), true);
  assert.equal(isLatestAlias("claude-haiku-5-5"), false);
  assert.equal(isLatestAlias("latest:"), false);
});

test("pickLatest takes the newest plain family member", () => {
  const anthropic = [
    { id: "claude-haiku-4-5-20251001", created: 1 }, { id: "claude-3-5-haiku-20241022", created: 0 },
    { id: "claude-haiku-5-5", created: 3 }, { id: "claude-sonnet-5-5", created: 3 }, { id: "claude-opus-5-5", created: 3 },
    { id: "claude-opus-4-1-20250805", created: 1 },
  ];
  assert.equal(pickLatest(["haiku"], anthropic)?.id, "claude-haiku-5-5");
  assert.equal(pickLatest(["opus"], anthropic)?.id, "claude-opus-5-5");
  assert.equal(pickLatest(["fable"], anthropic), null);
  // A newer release wins as soon as it is listed.
  assert.equal(pickLatest(["haiku"], [...anthropic, { id: "claude-haiku-6-0", created: 4 }])?.id, "claude-haiku-6-0");

  const opencode = ids("deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-pro", "qwen3.7-plus", "qwen3.7-max",
    "kimi-k2.7-code", "kimi-k3-code-preview", "glm-5.2");
  assert.equal(pickLatest(["deepseek", "flash"], opencode)?.id, "deepseek-v4.1-flash");
  assert.equal(pickLatest(["deepseek", "pro"], opencode)?.id, "deepseek-v4-pro");
  assert.equal(pickLatest(["qwen", "plus"], opencode)?.id, "qwen3.7-plus");
  // A variant with an extra word (preview) loses to the plain model even when its version is higher.
  assert.equal(pickLatest(["kimi", "code"], opencode)?.id, "kimi-k2.7-code");
  assert.equal(pickLatest(["glm"], [...opencode, { id: "glm-5.3" }])?.id, "glm-5.3");
});

test("listed IDs are untrusted: unsafe ones are dropped, both time formats are read", () => {
  const models = parseModelList({ data: [
    { id: "claude-haiku-5-5", created_at: "2026-10-01T00:00:00Z" }, { id: "kimi-k2.7-code", created: 1_700_000_000 },
    { id: "bad id; rm -rf" }, { id: 42 }, { id: "../etc" }, null,
  ] });
  assert.deepEqual(models.map((m) => m.id), ["claude-haiku-5-5", "kimi-k2.7-code"]);
  assert.equal(models[0].created, Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(models[1].created, 1_700_000_000_000);
  assert.deepEqual(parseModelList({ nope: true }), []);
});

function listing(models: string[] | (() => string[])) {
  let calls = 0;
  const provider: ModelProvider = {
    id: "fixture", endpoint: `fixture-${Math.random()}`,
    stream: async function* () { /* unused */ },
    listModels: async () => { calls += 1; const list = typeof models === "function" ? models() : models; return ids(...list); },
  };
  return { provider, calls: () => calls };
}

test("resolution is cached, falls back to the last good list, and errors clearly", async () => {
  clearModelListCache();
  let fail = false;
  const { provider, calls } = listing(() => { if (fail) throw new ProviderError("down", "connection"); return ["claude-haiku-5-5"]; });
  assert.equal(await resolveModel("latest:haiku", provider), "claude-haiku-5-5");
  assert.equal(await resolveModel("latest:haiku", provider), "claude-haiku-5-5");
  assert.equal(calls(), 1);
  fail = true;
  const later = Date.now() + 2 * 60 * 60 * 1_000;
  assert.deepEqual((await providerModels(provider, later)).map((m) => m.id), ["claude-haiku-5-5"]);
  assert.equal(calls(), 2);

  assert.equal(await resolveModel("claude-opus-5-5", provider), "claude-opus-5-5");
  await assert.rejects(resolveModel("latest:sonnet", provider), (e: any) => e instanceof ProviderError && e.category === "invalid_request" && /latest:sonnet/.test(e.message));
  const unlisted: ModelProvider = { id: "plain", stream: async function* () {} };
  await assert.rejects(resolveModel("latest:haiku", unlisted), /cannot list its models/);
  assert.equal(await resolveModel("latest:haiku", { id: "mock", stream: async function* () {} }), "latest:haiku");
  assert.deepEqual(await resolveModels(["latest:haiku", "claude-opus-5-5", "latest:haiku"], listing(["claude-haiku-5-5"]).provider),
    ["claude-haiku-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
});

test("the runner sends the concrete newest model, not the alias", async () => {
  clearModelListCache();
  const seen: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fixture", endpoint: "runner-fixture",
    listModels: async () => ids("claude-haiku-5-5", "claude-haiku-6-0", "claude-sonnet-5-5"),
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      seen.push(req);
      yield { type: "text.delta", text: "{\"answer\":\"ok\"}" };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } };
      yield { type: "response.completed", finishReason: "stop" };
    },
  };
  const result = await runResearchAgent({ agentName: "asset-analyst", title: "t", taskPacket: {}, prompt: "Return JSON.", provider,
    model: "latest:haiku", fallbackModel: null, outputFormat: { requiredKeys: ["answer"], validate: () => [] } });
  assert.equal(seen[0].model, "claude-haiku-6-0");
  assert.equal(result.attempts[0].model, "claude-haiku-6-0");
});

/** Stubs fetch (the providers require HTTPS) and records the URLs they ask for. */
async function withModels(body: unknown, run: (urls: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await run(urls); } finally { globalThis.fetch = original; }
}

test("Anthropic and OpenCode Go both list their models for aliases", async () => {
  clearModelListCache();
  await withModels({ data: [{ id: "claude-haiku-5-5", created_at: "2026-10-01T00:00:00Z" }, { id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" }] }, async (urls) => {
    const provider = new AnthropicCompatibleProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key", allowedHosts: ["api.anthropic.com"] });
    assert.equal(await resolveModel("latest:haiku", provider), "claude-haiku-5-5");
    assert.deepEqual(urls, ["https://api.anthropic.com/v1/models?limit=1000"]);
  });
  await withModels({ object: "list", data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4.1-flash" }, { id: "qwen3.7-plus" }, { id: "kimi-k2.7-code" }] }, async (urls) => {
    const provider = new OpenCodeGoProvider("https://opencode.ai/zen/go/v1", "test-key", ["opencode.ai"]);
    assert.equal(await resolveModel("latest:deepseek-flash", provider), "deepseek-v4.1-flash");
    assert.equal(await resolveModel("latest:kimi-code", provider), "kimi-k2.7-code");
    assert.deepEqual(urls, ["https://opencode.ai/zen/go/v1/models"], "one list call serves every alias");
  });
});

test("a model missing from the pricing table is priced as its family's newest priced model", () => {
  assert.equal(familyPricedModel("latest:haiku"), "claude-haiku-5-5");
  assert.equal(familyPricedModel("claude-haiku-6-0"), "claude-haiku-5-5");
  assert.equal(familyPricedModel("deepseek-v5-flash"), "deepseek-v4.1-flash");
  assert.equal(familyPricedModel("some-unknown-model"), null);
  assert.equal(calculateCost("claude-haiku-6-0", 1_000_000, 0), calculateCost("claude-haiku-5-5", 1_000_000, 0));
  assert.equal(calculateCost("latest:haiku", 0, 1_000_000), calculateCost("claude-haiku-5-5", 0, 1_000_000));
});
