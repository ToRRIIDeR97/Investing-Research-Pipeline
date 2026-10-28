import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { createPublicFetch, fetchCapped, guardedLookup, publicFetch, readCapped, type HostLookup } from "../src/lib/net";
import { MarketDataError } from "../src/lib/market-data/provider";
import { createYahooMarketDataProvider } from "../src/lib/market-data/providers/yahoo";
import { fetchStooqCloses } from "../src/lib/market-data/providers/stooq";
import { discoverRoleSources, isSafePublicUrl, unwrapDuckDuckGoUrl, type SearchFailure } from "../src/lib/research/sources/role-discovery";

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

test("discovery refuses IPv6 loopback, IPv4-mapped, CGNAT, ULA, link-local, NAT64, 6to4, Teredo and numeric loopback hosts (#9)", () => {
  for (const url of ["http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://100.64.0.1/", "http://2130706433/",
    "http://[fd00::1]/", "http://[fe80::1]/", "http://169.254.169.254/latest", "http://0.0.0.0/", "http://[::]/",
    "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[64:ff9b:1::1]/", "http://[2002:7f00:1::]/",
    "http://[2001:0:4136:e378::1]/", "http://[::ffff:0:7f00:1]/"]) {
    assert.equal(isSafePublicUrl(url), false, url);
  }
  assert.equal(isSafePublicUrl("https://www.sec.gov/Archives/x.htm"), true);
  assert.equal(isSafePublicUrl("https://100.128.0.1/"), true);
});

// fetch reports a refused connection as "fetch failed" with the guard's error as the cause.
const refused = (error: Error & { cause?: Error }) => /non-public/.test(String(error.cause?.message));
const lookupWith =(resolve: HostLookup, hostname: string, options: { all?: boolean; family?: number } = {}) =>
  new Promise<unknown>((done, fail) => guardedLookup(resolve)(hostname, options, (error, address, family) =>
    error ? fail(error) : done(options.all ? address : { address, family })));

test("the socket lookup passes on an answer only when every address is public (#9)", async () => {
  await assert.rejects(lookupWith(async () => ["93.184.216.34", "127.0.0.1"], "rebind.example"), /non-public/);
  await assert.rejects(lookupWith(async () => ["::ffff:10.0.0.1"], "mapped.example"), /non-public/);
  await assert.rejects(lookupWith(async () => ["169.254.169.254"], "metadata.example"), /non-public/);
  await assert.rejects(lookupWith(async () => ["100.64.0.1"], "cgnat.example"), /non-public/);
  await assert.rejects(lookupWith(async () => ["fe80::1"], "linklocal.example"), /non-public/);
  await assert.rejects(lookupWith(async () => ["64:ff9b::a9fe:a9fe"], "nat64.example"), /non-public/);
  await assert.rejects(lookupWith(async () => [], "empty.example"), /non-public/);
  const missing = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  await assert.rejects(lookupWith(async () => { throw missing; }, "missing.example"), /ENOTFOUND/);
  const resolve = async () => ["93.184.216.34", "2606:4700::1111"];
  assert.deepEqual(await lookupWith(resolve, "public.example"), { address: "93.184.216.34", family: 4 });
  assert.deepEqual(await lookupWith(resolve, "public.example", { family: 6 }), { address: "2606:4700::1111", family: 6 });
  assert.deepEqual(await lookupWith(resolve, "public.example", { all: true }),
    [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
  // The default discovery fetch refuses literals before any connection is attempted.
  await assert.rejects(publicFetch("http://[::1]/"), refused);
  await assert.rejects(publicFetch("http://localhost/"), refused);
});

test("public fetch connects to the address it validated, once per connection and per redirect hop (#9)", async () => {
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    hosts.push(String(request.headers.host));
    if (request.url === "/to-name") response.writeHead(302, { location: `http://private.test:${port}/` }).end();
    else if (request.url === "/to-literal") response.writeHead(302, { location: `http://127.0.0.2:${port}/` }).end();
    else response.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  // 127.0.0.1 stands in for a public address; every other address is treated as private.
  const allowed = (address: string) => address === "127.0.0.1";
  const answers: Record<string, string[][]> = {
    "rebind.test": [["127.0.0.1"], ["10.0.0.1"]], "start.test": [["127.0.0.1"]], "private.test": [["10.0.0.1"]], "mixed.test": [["127.0.0.1", "10.0.0.1"]],
  };
  const lookups: string[] = [];
  const resolve: HostLookup = async (hostname) => {
    lookups.push(hostname);
    const queue = answers[hostname];
    return queue.length > 1 ? queue.shift()! : queue[0];
  };
  try {
    const guarded = createPublicFetch({ resolve, allowed });
    const first = await guarded(`http://rebind.test:${port}/`);
    assert.equal(await first.text(), "ok");
    assert.deepEqual(lookups, ["rebind.test"]);
    assert.equal(hosts[0], `rebind.test:${port}`); // the Host header keeps the name, not the IP
    // A fresh connection resolves again and refuses the rebound answer instead of connecting to it.
    await assert.rejects(createPublicFetch({ resolve, allowed })(`http://rebind.test:${port}/`), refused);
    await assert.rejects(guarded(`http://mixed.test:${port}/`), refused);
    assert.equal(hosts.length, 1);
    // Followed redirects connect through the same guard, to a name or to an IP literal.
    for (const path of ["/to-name", "/to-literal"]) {
      await assert.rejects(guarded(`http://start.test:${port}${path}`), refused, path);
    }
    assert.deepEqual(hosts.slice(1), [`start.test:${port}`, `start.test:${port}`]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
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

  // An oversized answer loses that query only (#113).
  const endlessJson = (async () => new Response(endless(), { headers: { "content-type": "application/json" } })) as typeof fetch;
  const searchFailures: SearchFailure[] = [];
  assert.deepEqual(await withEnv(discoveryEnv(), () => discoverRoleSources({ assetName: "Acme Company", symbol: "ACME", searchFailures },
    ["founder_and_company_history"], endlessJson)), []);
  assert.ok(searchFailures.length > 0);
  assert.ok(searchFailures.every((failure) => failure.role === "founder_and_company_history" && /exceeds/.test(failure.error)));
});

test("one failed web search does not fail discovery; the other queries still run (#113)", async () => {
  const page = `<html><head><title>Acme founder history</title></head><body><p>${"documented founder history of Acme ".repeat(90)}</p></body></html>`;
  let searches = 0;
  const fetchMock = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://search.example/api")) {
      searches += 1;
      if (searches === 1) throw new TypeError("fetch failed: ECONNRESET");
      return Response.json({ results: [{ url: "https://acme.example/history", title: "Acme history" }] });
    }
    return new Response(page, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const searchFailures: SearchFailure[] = [];
  const sources = await withEnv(discoveryEnv(), () => discoverRoleSources({ assetName: "Acme Company", symbol: "ACME", searchFailures },
    ["founder_and_company_history"], fetchMock));
  assert.equal(searchFailures.length, 1);
  assert.match(searchFailures[0].error, /ECONNRESET/);
  assert.ok(searches > 1);
  assert.equal(sources.length, 1);
});

test("a truncating read ignores a large Content-Length (#126)", async () => {
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html", "content-length": 3_000_000 });
    response.end("x".repeat(3_000_000));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  try {
    assert.equal((await readCapped(await fetch(`http://127.0.0.1:${port}/`), 1_000_000, true)).byteLength, 1_000_000);
    await assert.rejects(readCapped(await fetch(`http://127.0.0.1:${port}/`), 1_000_000), /exceeds 1000000 bytes/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a DuckDuckGo result URL is decoded once (#135)", () => {
  const target = "https://acme.example/report?file=a%2Fb&x=1%26y";
  assert.equal(unwrapDuckDuckGoUrl(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`), target);
  assert.equal(unwrapDuckDuckGoUrl("https://acme.example/page"), "https://acme.example/page");
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
