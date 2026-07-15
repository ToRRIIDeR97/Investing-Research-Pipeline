import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { ProviderError } from "../src/lib/agent-harness/errors";
import { OpenAICompatibleProvider } from "../src/lib/agent-harness/providers/openai-compatible";
import { runResearchAgent } from "../src/lib/agent-harness/runner";

async function fixture(handler: (response: ServerResponse) => void) {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[{"id":"fixture-model"}]}');
      return;
    }
    handler(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}

test("local provider parses fragmented SSE, usage, request IDs, and health", async () => {
  const { server, url } = await fixture((response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req-fixture" });
    response.write('data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n');
    response.write('\ndata: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
    response.end('data: [DONE]\n\n');
  });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: url });
    const health = await provider.healthCheck();
    assert.equal(health.status, "healthy");
    const events = [];
    for await (const event of provider.stream({ model: "fixture", prompt: "x" }, new AbortController().signal)) events.push(event);
    assert.equal((events.find((event) => event.type === "response.started") as any)?.requestId, "req-fixture");
    assert.equal(events.filter((event: any) => event.type === "text.delta").map((event: any) => event.text).join(""), '{"ok":true}');
    assert.ok(events.some((event: any) => event.type === "usage" && event.usage.outputTokens === 2));
  } finally { server.close(); }
});

test("provider rejects malformed and unterminated SSE", async () => {
  const malformed = await fixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("data: {bad}\n\n"); });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: malformed.url });
    await assert.rejects(async () => { for await (const _ of provider.stream({ model: "x", prompt: "x" }, new AbortController().signal)) {} },
      (error: any) => error instanceof ProviderError && error.category === "malformed_stream");
  } finally { malformed.server.close(); }

  const incomplete = await fixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'); });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: incomplete.url });
    await assert.rejects(async () => { for await (const _ of provider.stream({ model: "x", prompt: "x" }, new AbortController().signal)) {} }, /completion marker/);
  } finally { incomplete.server.close(); }

  const missingData = await fixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("event: message\n\n"); });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: missingData.url });
    await assert.rejects(async () => { for await (const _ of provider.stream({ model: "x", prompt: "x" }, new AbortController().signal)) {} }, /without data/);
  } finally { missingData.server.close(); }
});

test("provider classifies server failures as server errors", async () => {
  const failed = await fixture((response) => { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"unavailable"}'); });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: failed.url });
    await assert.rejects(
      async () => { for await (const _ of provider.stream({ model: "x", prompt: "x" }, new AbortController().signal)) {} },
      (error: any) => error instanceof ProviderError && error.category === "server_error"
    );
  } finally { failed.server.close(); }
});

test("provider exposes rate-limit retry timing", async () => {
  const limited = await fixture((response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
    response.end('{"error":"slow down"}');
  });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: limited.url });
    await assert.rejects(
      async () => { for await (const _ of provider.stream({ model: "x", prompt: "x" }, new AbortController().signal)) {} },
      (error: any) => error instanceof ProviderError && error.category === "rate_limit" && error.details.retryAfter === "2"
    );
  } finally { limited.server.close(); }
});

test("provider normalizes authentication, invalid request, context, and timeout HTTP errors", async () => {
  const cases = [
    { status: 401, body: '{"error":"unauthorized"}', category: "authentication" },
    { status: 400, body: '{"error":"bad parameter"}', category: "invalid_request" },
    { status: 400, body: '{"error":"context length exceeded"}', category: "context_limit" },
    { status: 408, body: '{"error":"timed out"}', category: "provider_timeout" },
  ];
  for (const item of cases) {
    const failed = await fixture((response) => {
      response.writeHead(item.status, { "content-type": "application/json" });
      response.end(item.body);
    });
    try {
      const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: failed.url });
      await assert.rejects(
        async () => { for await (const _ of provider.stream({ model: "x", prompt: "x" }, new AbortController().signal)) {} },
        (error: any) => error instanceof ProviderError && error.category === item.category
      );
    } finally { failed.server.close(); }
  }
});

test("provider error bodies redact bearer credentials", async () => {
  const failed = await fixture((response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("Bearer super-secret-token was rejected");
  });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: failed.url });
    await assert.rejects(
      async () => { for await (const _ of provider.stream({ model: "x", prompt: "x" }, new AbortController().signal)) {} },
      (error: any) => error instanceof ProviderError && !error.message.includes("super-secret-token") && error.message.includes("[REDACTED]")
    );
  } finally { failed.server.close(); }
});

test("real HTTP stream is aborted by the inactivity deadline", async () => {
  const slow = await fixture((response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "slow-request" });
    response.write('data: {"choices":[{"delta":{"content":"{\\"selected_profile_key\\":\\"partial"}}]}\n\n');
    const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 100);
    response.on("close", () => clearTimeout(timer));
  });
  try {
    const provider = new OpenAICompatibleProvider({ mode: "local", baseUrl: slow.url });
    await assert.rejects(
      () => runResearchAgent({
        agentName: "asset-classifier", title: "slow fixture", taskPacket: {}, provider,
        policy: { totalTimeoutMs: 1_000, inactivityTimeoutMs: 20, maxAttempts: 1 },
      }),
      (error: any) => error.attempts?.[0]?.timeoutType === "inactivity" && error.attempts[0].rawResponseExcerpt.includes("partial")
    );
  } finally { slow.server.close(); }
});

test("direct provider requires HTTPS, API key, and exact host allowlist", () => {
  assert.throws(() => new OpenAICompatibleProvider({ mode: "direct", baseUrl: "http://example.com/v1", apiKey: "x", allowedHosts: ["example.com"] }), /HTTPS/);
  assert.throws(() => new OpenAICompatibleProvider({ mode: "direct", baseUrl: "https://example.com/v1", allowedHosts: ["example.com"] }), /API_KEY/);
  assert.throws(() => new OpenAICompatibleProvider({ mode: "direct", baseUrl: "https://evil.example/v1", apiKey: "x", allowedHosts: ["example.com"] }), /allowlisted/);
});
