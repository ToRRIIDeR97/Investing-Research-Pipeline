import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { assertPublicHost, fetchCapped, publicFetch, readCapped } from "../src/lib/net";
import { MarketDataError } from "../src/lib/market-data/provider";
import { createYahooMarketDataProvider } from "../src/lib/market-data/providers/yahoo";
import { fetchStooqCloses } from "../src/lib/market-data/providers/stooq";
import { discoverRoleSources, isSafePublicUrl } from "../src/lib/research/sources/role-discovery";

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const discoveryEnv = (extra: Record<string, string | undefined> = {}) => ({
  RESEARCH_WEB_SEARCH_ENDPOINT: "https://search.example/api", RESEARCH_WEB_SEARCH_API_KEY: undefined,
  RESEARCH_ACCEPTANCE_PROVIDER: undefined, RESEARCH_TEST_MODE: undefined, RESEARCH_WEB_DISCOVERY_ENABLED: undefined, ...extra,
});

const endless = () => new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65_536).fill(97)); } });

test("discovery refuses IPv6 loopback, IPv4-mapped, CGNAT, ULA, link-local and numeric loopback hosts (#9)", () => {
  for (const url of ["http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://100.64.0.1/", "http://2130706433/",
    "http://[fd00::1]/", "http://[fe80::1]/", "http://169.254.169.254/latest", "http://0.0.0.0/", "http://[::]/"]) {
    assert.equal(isSafePublicUrl(url), false, url);
  }
  assert.equal(isSafePublicUrl("https://www.sec.gov/Archives/x.htm"), true);
  assert.equal(isSafePublicUrl("https://100.128.0.1/"), true);
});

test("a hostname is fetched only when every address it resolves to is public (#9)", async () => {
  await assert.rejects(assertPublicHost("rebind.example", async () => ["93.184.216.34", "127.0.0.1"]), /non-public/);
  await assert.rejects(assertPublicHost("mapped.example", async () => ["::ffff:10.0.0.1"]), /non-public/);
  await assert.rejects(assertPublicHost("empty.example", async () => []), /non-public/);
  await assertPublicHost("public.example", async () => ["93.184.216.34", "2606:4700::1111"]);
  // A name that doesn't resolve is left to fetch, which fails on it too (or, in tests, is stubbed).
  await assertPublicHost("missing.example", async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); });
  let looked = false;
  await assert.rejects(assertPublicHost("[::1]", async () => { looked = true; return []; }), /non-public/);
  assert.equal(looked, false);
  // The default discovery fetch checks literals before any connection is attempted.
  await assert.rejects(publicFetch("http://[::1]:9/"), /non-public/);
  await assert.rejects(publicFetch("http://localhost:9/"), /non-public/);
});

test("a redirect to a private address is not followed (#9)", async () => {
  const fetched: string[] = [];
  const fetchMock = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith("https://search.example/api")) {
      return Response.json({ results: [{ url: "https://acme.example/history", title: "Acme history" }] });
    }
    return new Response(null, { status: 302, headers: { location: "http://[::1]/admin" } });
  }) as typeof fetch;
  const sources = await withEnv(discoveryEnv(), () => discoverRoleSources({ assetName: "Acme Company", symbol: "ACME" },
    ["founder_and_company_history"], fetchMock));
  assert.equal(sources.length, 0);
  assert.equal(fetched.some((url) => url.includes("[::1]")), false);
});

test("response bodies are capped after decoding, not by Content-Length (S3)", async () => {
  // 50 MB of zeros gzips to about 50 KB; Content-Length reports the compressed size.
  const bomb = gzipSync(Buffer.alloc(50_000_000));
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": bomb.length });
    response.end(bomb);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  try {
    const before = process.memoryUsage().arrayBuffers;
    await assert.rejects(readCapped(await fetch(`http://127.0.0.1:${port}/`), 1_000_000), /exceeds 1000000 bytes/);
    const truncated = await readCapped(await fetch(`http://127.0.0.1:${port}/`), 1_000_000, true);
    assert.equal(truncated.byteLength, 1_000_000);
    assert.ok(process.memoryUsage().arrayBuffers - before < 20_000_000);
  } finally {
    server.close();
  }

  // An endless page or PDF ends discovery of that candidate instead of exhausting memory.
  for (const type of ["text/html", "application/pdf"]) {
    const fetchMock = (async (input: string | URL | Request) => String(input).startsWith("https://search.example/api")
      ? Response.json({ results: [{ url: "https://acme.example/history", title: "Acme history" }] })
      : new Response(endless(), { headers: { "content-type": type } })) as typeof fetch;
    const sources = await withEnv(discoveryEnv(), () => discoverRoleSources({ assetName: "Acme Company", symbol: "ACME" },
      ["founder_and_company_history"], fetchMock));
    assert.equal(sources.length, 0, type);
  }
});

test("the web-search key goes to the configured HTTPS endpoint only, and its JSON is bounded (#22)", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith("https://search.example/api")) {
      return new Response(null, { status: 307, headers: { location: "https://mirror.example/api?q=x" } });
    }
    return Response.json({ results: [] });
  }) as typeof fetch;
  await withEnv(discoveryEnv({ RESEARCH_WEB_SEARCH_API_KEY: "search-secret" }), () =>
    discoverRoleSources({ assetName: "Acme Company", symbol: "ACME" }, ["founder_and_company_history"], fetchMock));
  assert.equal(calls[0].headers.get("authorization"), "Bearer search-secret");
  assert.equal(calls[0].headers.get("ocp-apim-subscription-key"), "search-secret");
  const redirected = calls.filter((call) => call.url.startsWith("https://mirror.example/"));
  assert.ok(redirected.length > 0);
  assert.ok(redirected.every((call) => !call.headers.has("authorization") && !call.headers.has("ocp-apim-subscription-key")));

  await assert.rejects(withEnv(discoveryEnv({ RESEARCH_WEB_SEARCH_ENDPOINT: "http://search.example/api" }), () =>
    discoverRoleSources({ assetName: "Acme Company", symbol: "ACME" }, ["founder_and_company_history"], fetchMock)), /HTTPS/);

  const endlessJson = (async () => new Response(endless(), { headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(withEnv(discoveryEnv(), () =>
    discoverRoleSources({ assetName: "Acme Company", symbol: "ACME" }, ["founder_and_company_history"], endlessJson)), /exceeds/);
});

test("structured-data fetches time out and cap their bodies (#23)", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/silent") return; // never answers
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/stalled") response.write("{"); // headers, then a body that never ends
    else response.end("x".repeat(2_000_000));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of ["/silent", "/stalled"]) {
      const started = performance.now();
      await assert.rejects(fetchCapped(`${base}${path}`, {}, { timeoutMs: 200 }), (error: Error) => error.name === "TimeoutError", path);
      assert.ok(performance.now() - started < 2_000, path);
    }
    await assert.rejects(fetchCapped(`${base}/large`, {}, { maxBytes: 1_000_000 }), /exceeds/);
    const response = await fetchCapped(`${base}/large`);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).length, 2_000_000);
  } finally {
    server.closeAllConnections();
    server.close();
  }

  const endlessFetch = (async () => new Response(endless(), { headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(createYahooMarketDataProvider(endlessFetch).getQuote("ACME"),
    (error: Error) => error instanceof MarketDataError && /exceeds/.test(error.message));
  const stooq = await fetchStooqCloses("ACME", new Date("2024-01-01"), new Date("2024-02-01"), endlessFetch);
  assert.equal(stooq.status, "unavailable");
});
