import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/lib/agent-harness/providers/openai-compatible";
import { AnthropicCompatibleProvider } from "../src/lib/agent-harness/providers/anthropic-compatible";
import { getEmbeddingProvider } from "../src/lib/research/memory/embeddings";
import { redact } from "../src/lib/agent-harness/runner";

test("model and embedding endpoints share one validator (#25)", async () => {
  assert.throws(() => new OpenAICompatibleProvider({ mode: "direct", baseUrl: "https://[::1]/v1", apiKey: "x", allowedHosts: ["[::1]"] }), /private/);
  assert.throws(() => new OpenAICompatibleProvider({ mode: "direct", baseUrl: "https://api.example/v1?x=1", apiKey: "x", allowedHosts: ["api.example"] }), /query/);
  assert.doesNotThrow(() => new OpenAICompatibleProvider({ mode: "local", baseUrl: "http://[::1]:8080/v1" }));
  assert.throws(() => new OpenAICompatibleProvider({ mode: "local", baseUrl: "http://api.example/v1" }), /loopback or private/);
  assert.throws(() => new AnthropicCompatibleProvider({ baseUrl: "https://10.0.0.5/v1", apiKey: "x", allowedHosts: ["10.0.0.5"] }), /private/);
  assert.throws(() => new AnthropicCompatibleProvider({ baseUrl: "https://api.anthropic.com/v1#frag", apiKey: "x", allowedHosts: ["api.anthropic.com"] }), /fragment/);
  assert.throws(() => getEmbeddingProvider({ RESEARCH_EMBEDDING_PROVIDER: "openai-compatible", RESEARCH_EMBEDDING_BASE_URL: "https://169.254.169.254/v1",
    RESEARCH_MODEL_ALLOWED_HOSTS: "169.254.169.254", RESEARCH_EMBEDDING_MODEL: "m", RESEARCH_EMBEDDING_API_KEY: "k" }), /private/);

  const originalFetch = globalThis.fetch;
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    redirect = init?.redirect;
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1 } });
  }) as typeof fetch;
  try {
    await getEmbeddingProvider({ RESEARCH_EMBEDDING_PROVIDER: "openai-compatible", RESEARCH_EMBEDDING_BASE_URL: "https://embed.example/v1",
      RESEARCH_MODEL_ALLOWED_HOSTS: "embed.example", RESEARCH_EMBEDDING_MODEL: "m", RESEARCH_EMBEDDING_API_KEY: "k" })!.embed(["text"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(redirect, "error");
});

test("harness redaction covers the OpenCode, web-search and embedding keys (#10)", () => {
  const keys = { OPENCODE_GO_API_KEY: "opencode-secret-1", RESEARCH_WEB_SEARCH_API_KEY: "search-secret-2", RESEARCH_EMBEDDING_API_KEY: "embedding-secret-3" };
  const saved = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, keys);
  try {
    const message = redact(`failed with ${Object.values(keys).join(", ")}`);
    assert.equal(message, "failed with [REDACTED], [REDACTED], [REDACTED]");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
