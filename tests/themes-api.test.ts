// T-7: theme research end to end against PostgreSQL with the mock provider and stubbed SEC fetches (no network):
// framing, two overlapping candidate lists, SEC's SIC list and the operator's tickers counted for agreement,
// validation, exclusions, scorecards from companyfacts, ranking and a shortlist of four; plus the routes' checks.
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { NextRequest } from "next/server";
import type { ModelProvider, ModelRequest } from "../src/lib/agent-harness/types";

const request = (url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });

const SEC = {
  0: { ticker: "PWR", title: "QUANTA SERVICES, INC.", cik_str: 1050915 }, 1: { ticker: "HUBB", title: "HUBBELL INC", cik_str: 48898 },
  2: { ticker: "ETN", title: "Eaton Corp plc", cik_str: 1551182 }, 3: { ticker: "MTZ", title: "MASTEC INC", cik_str: 15615 },
  4: { ticker: "GEV", title: "GE Vernova Inc.", cik_str: 1996810 }, 5: { ticker: "NEE", title: "NEXTERA ENERGY INC", cik_str: 753308 },
  6: { ticker: "MYRG", title: "MYR GROUP INC.", cik_str: 700923 }, 7: { ticker: "ABB", title: "ABB LTD", cik_str: 1091587 },
  8: { ticker: "SIEGY", title: "Siemens AG (fixture)", cik_str: 1000001 },
};
const SIC_PAGE = `<table class="tableFile2"><tr><th>CIK</th><th>Company</th><th>State</th></tr>
  <tr><td><a href="/cgi-bin/browse-edgar?action=getcompany&CIK=0001050915&type=10-K">0001050915</a></td><td>QUANTA SERVICES, INC.</td><td>TX</td></tr>
  <tr><td><a href="/cgi-bin/browse-edgar?action=getcompany&CIK=0000015615&type=10-K">0000015615</a></td><td>MASTEC INC</td><td>FL</td></tr>
  <tr><td><a href="/cgi-bin/browse-edgar?action=getcompany&CIK=0000700923&type=10-K">0000700923</a></td><td>MYR GROUP INC.</td><td>DE</td></tr>
  <tr><td><a href="/cgi-bin/browse-edgar?action=getcompany&CIK=0009999999&type=10-K">0009999999</a></td><td>No ticker LLC</td><td>DE</td></tr></table>`;
const fy = (year: number, val: number) => ({ start: `${year}-01-01`, end: `${year}-12-31`, val, fy: year, fp: "FY", form: "10-K", filed: `${year + 1}-02-20` });
const at = (year: number, val: number) => ({ end: `${year}-12-31`, val, fy: year, fp: "FY", form: "10-K", filed: `${year + 1}-02-20` });
/** companyfacts with growth `g`, margin `m` and net debt `d` (FCF 100). */
const facts = (g: number, m: number, d: number) => ({ facts: { "us-gaap": {
  Revenues: { units: { USD: [2020, 2021, 2022, 2023, 2024, 2025].map((y, i) => fy(y, 1000 * (1 + g) ** i)) } },
  OperatingIncomeLoss: { units: { USD: [fy(2025, 1000 * (1 + g) ** 5 * m)] } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fy(2025, 150)] } }, PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fy(2025, 50)] } },
  LongTermDebt: { units: { USD: [at(2025, d + 100)] } }, CashAndCashEquivalentsAtCarryingValue: { units: { USD: [at(2025, 100)] } },
  EarningsPerShareDiluted: { units: { "USD/shares": [fy(2025, 4)] } } } } });
const FACTS: Record<string, unknown> = { "0001050915": facts(0.15, 0.08, 100), "0000048898": facts(0.08, 0.2, 300), "0001551182": facts(0.06, 0.18, 400),
  "0000015615": facts(0.12, 0.05, 200), "0001996810": facts(0.2, 0.06, -50), "0000700923": facts(0.1, 0.04, 50) };

test("a theme's model spend accumulates across runs, failed ones included, and stops at the cumulative cap", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const { createTheme, runTheme } = await import("../src/lib/api/themes");
  const { resetThemeCaches } = await import("../src/lib/research/themes/pipeline");
  const { MockProvider } = await import("../src/lib/agent-harness/providers/mock");
  const run = await import("../src/app/api/themes/[id]/run/route");
  // The mock model, reporting $0.05 per call.
  const mock = new MockProvider();
  const costly: ModelProvider = { id: "mock", async *stream(request: ModelRequest, signal: AbortSignal) {
    for await (const event of mock.stream(request, signal)) yield event.type === "usage" ? { ...event, usage: { ...event.usage, costUsd: 0.05 } } : event;
  } };
  const secFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://www.sec.gov/files/company_tickers.json") return Response.json(SEC);
    if (url.includes("SIC=1623")) return new Response(SIC_PAGE);
    const cik = /CIK(\d{10})\.json$/.exec(url)?.[1];
    return cik && FACTS[cik] ? Response.json(FACTS[cik]) : new Response("no", { status: 404 });
  }) as typeof fetch;
  const secDown = (async (input: RequestInfo | URL) => String(input).includes("company_tickers") ? new Response("down", { status: 503 }) : secFetch(input)) as typeof fetch;
  const env = { THEME_RESEARCH_BUDGET_USD: "0.5", RESEARCH_MID_ATTEMPT_BUDGET_RESERVE_USD: "0.01", RESEARCH_CHEAP_ATTEMPT_BUDGET_RESERVE_USD: "0.01" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let id = "";
  const cost = async () => Number((await sql`SELECT cost_usd FROM theme_research WHERE id = ${id}`)[0].cost_usd);
  try {
    id = (await createTheme({ theme: "Budget test theme", horizon_years: 10, roles: ["supplier"], min_exposure: 0.5, us_only: true,
      objectives: { growth: 1, quality: 0, value: 0, balance_sheet: 0 } })).id;
    // Four model calls a run at $0.05: $0.20 recorded on success.
    resetThemeCaches();
    const first = await runTheme(id, { fetch: secFetch, price: async () => 80, provider: costly });
    assert.equal(first.status, "completed", String(first.error));
    assert.equal(await cost(), 0.2);
    // The four calls are paid before SEC fails: the failed run still adds $0.20.
    resetThemeCaches();
    const second = await runTheme(id, { fetch: secDown, price: async () => null, provider: costly });
    assert.equal(second.status, "failed");
    assert.equal(await cost(), 0.4);
    // $0.10 is left of the $0.50 cap: two calls fit, the third is refused before it is made, and the $0.10 is recorded.
    resetThemeCaches();
    const third = await runTheme(id, { fetch: secFetch, price: async () => 80, provider: costly });
    assert.equal(third.status, "failed");
    assert.match(third.error, /model budget would be exceeded/);
    assert.equal(await cost(), 0.5);
    // At the cap: refused before anything runs, with the reason.
    const refused = await run.POST(new NextRequest(`http://localhost/api/themes/${id}/run`, { method: "POST" }), { params: Promise.resolve({ id }) });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.code, "BUDGET_SPENT");
    assert.match(body.error, /used its model budget \(\$0\.50 of \$0\.50\)/);
    assert.equal(await cost(), 0.5);
    // A run overtaken by a stuck-run reclaim keeps the newer claim's status but still adds its spend.
    process.env.THEME_RESEARCH_BUDGET_USD = "5";
    resetThemeCaches();
    const overtaken = await runTheme(id, { fetch: secFetch, provider: costly, price: async () => {
      await sql`UPDATE theme_research SET started_at = clock_timestamp(), status = 'running' WHERE id = ${id}`;
      return 80;
    } });
    assert.equal(overtaken.status, "running", "the newer claim's status is kept");
    assert.equal(await cost(), 0.7);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (id) await sql`DELETE FROM theme_research WHERE id = ${id}`;
    await sql.end();
  }
});

test("theme research runs end to end with the mock provider and stubbed SEC fetches", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const ids: string[] = [];
  const themes = await import("../src/app/api/themes/route");
  const one = await import("../src/app/api/themes/[id]/route");
  const run = await import("../src/app/api/themes/[id]/run/route");
  const { runTheme } = await import("../src/lib/api/themes");
  const { resetThemeCaches } = await import("../src/lib/research/themes/pipeline");
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const fetched: string[] = [];
  const secFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    assert.match(String((init?.headers as Record<string, string>)?.["User-Agent"] ?? ""), /ResearchOS/);
    if (url === "https://www.sec.gov/files/company_tickers.json") return Response.json(SEC);
    if (url.startsWith("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=1623")) return new Response(SIC_PAGE, { headers: { "content-type": "text/html" } });
    const cik = /CIK(\d{10})\.json$/.exec(url)?.[1];
    if (cik && FACTS[cik]) return Response.json(FACTS[cik]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const body = { theme: "Future of electricity: the grid", horizon_years: 15, roles: ["supplier"], min_exposure: 0.5, us_only: true,
    objectives: { growth: 1, quality: 0.5, value: 0.5, balance_sheet: 0.5 }, tickers: ["myrg", "ZZZZ"] };
  try {
    resetThemeCaches();
    // Create: validated and bounded; another origin is refused.
    const created = await themes.POST(request("/api/themes", "POST", body));
    assert.equal(created.status, 201);
    const theme = await created.json();
    ids.push(theme.id);
    assert.deepEqual([theme.status, theme.request.tickers], ["pending", ["MYRG", "ZZZZ"]]);
    assert.equal((await themes.POST(request("/api/themes", "POST", { ...body, roles: [] }))).status, 400);
    assert.equal((await themes.POST(request("/api/themes", "POST", { ...body, extra: 1 }))).status, 400);
    assert.equal((await themes.POST(request("/api/themes", "POST", "{nope"))).status, 400);
    assert.equal((await themes.POST(request("/api/themes", "POST", { ...body, theme: "x".repeat(20_000) }))).status, 413);
    assert.equal((await themes.POST(request("/api/themes", "POST", body, { origin: "https://unrelated.example" }))).status, 403);
    assert.equal((await one.GET(request("/"), params("not-a-uuid"))).status, 404);
    assert.equal((await run.POST(request("/", "POST", undefined, { origin: "https://unrelated.example" }), params(theme.id))).status, 403);

    // Run: the whole pipeline with the mock provider and the SEC stubs.
    const done = await runTheme(theme.id, { fetch: secFetch, price: async (t) => t === "NEE" ? null : 80 });
    assert.equal(done.status, "completed", String(done.error));
    const r = done.result;
    assert.match(r.framing.label, /Model framing/);
    assert.deepEqual(r.framing.etfs, ["GRID"]);
    assert.deepEqual(r.sources.map((s: { source: string }) => s.source), ["model:suppliers", "model:leaders", "sec:sic-1623", "operator"]);
    assert.deepEqual(r.sic[0].tickers, ["PWR", "MTZ", "MYRG"], "CIKs mapped through company_tickers.json; one without a ticker is dropped");
    const pwr = r.candidates.find((c: { ticker: string }) => c.ticker === "PWR");
    assert.deepEqual([pwr.count, pwr.sources], [3, ["model:suppliers", "model:leaders", "sec:sic-1623"]]);
    const reasons = Object.fromEntries(r.excluded.map((e: { ticker: string; reason: string }) => [e.ticker, e.reason]));
    assert.match(reasons.NEE, /role you did not ask for/);
    assert.match(reasons.SIEGY, /below your minimum/);
    assert.match(reasons.ABB, /no US listing/);
    assert.match(reasons.ZZZZ, /not in SEC's list/);
    assert.deepEqual(r.candidates.find((c: { ticker: string }) => c.ticker === "MYRG").flags, ["exposure unknown", "role not classified (your ticker)"]);
    assert.equal(r.candidates.find((c: { ticker: string }) => c.ticker === "ETN").exposure, 0.6, "the mean of the estimates given (one list gave none)");
    assert.deepEqual(r.scorecard.map((s: { ticker: string }) => s.ticker).sort(), ["ETN", "GEV", "HUBB", "MTZ", "MYRG", "PWR"]);
    const gev = r.scorecard.find((s: { ticker: string }) => s.ticker === "GEV");
    assert.ok(Math.abs(gev.revenue_cagr_5y - 0.2) < 1e-9 && gev.payback_years === 0 && Math.abs(gev.pe_ttm - 20) < 1e-9, JSON.stringify(gev));
    assert.equal(r.shortlist.length, 4);
    assert.equal(r.ranked[0].ticker, r.shortlist[0].ticker);
    assert.ok(r.ranked.every((x: { score: number }, i: number, all: { score: number }[]) => i === 0 || all[i - 1].score >= x.score));
    assert.deepEqual(r.ownership.map((o: { kind: string }) => o.kind), ["basket", "leader", "etf"]);
    assert.ok(fetched.every((u) => u.startsWith("https://www.sec.gov/") || u.startsWith("https://data.sec.gov/")), "SEC hosts only");
    assert.ok(Number(done.cost_usd) >= 0);

    // Read and list.
    const read = await (await one.GET(request("/"), params(theme.id))).json();
    assert.deepEqual([read.status, read.result.shortlist.length], ["completed", 4]);
    const listed = await (await themes.GET()).json();
    assert.deepEqual(listed.find((t: { id: string }) => t.id === theme.id).shortlist, read.result.shortlist);

    // 409 while running; a failure is stored with a reader-facing error; the paid gate.
    await sql`UPDATE theme_research SET status = 'running', started_at = NOW() WHERE id = ${theme.id}`;
    assert.equal((await run.POST(request("/", "POST"), params(theme.id))).status, 409);
    await sql`UPDATE theme_research SET status = 'pending' WHERE id = ${theme.id}`;
    resetThemeCaches();
    const broken = (async (input: RequestInfo | URL) => String(input).includes("company_tickers") ? new Response("down", { status: 503 }) : secFetch(input)) as typeof fetch;
    const failed = await runTheme(theme.id, { fetch: broken, price: async () => null });
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /^Theme research failed: SEC's ticker list could not be read \(HTTP 503\)/);
    const saved = { RUN_PAID_RESEARCH: process.env.RUN_PAID_RESEARCH, RESEARCH_MODEL_PROVIDER: process.env.RESEARCH_MODEL_PROVIDER };
    delete process.env.RUN_PAID_RESEARCH; delete process.env.RESEARCH_MODEL_PROVIDER;
    try { assert.equal((await run.POST(request("/", "POST"), params(theme.id))).status, 503); }
    finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    assert.equal((await run.POST(request("/", "POST"), params(crypto.randomUUID()))).status, 404);
  } finally {
    if (ids.length) await sql`DELETE FROM theme_research WHERE id = ANY(${ids}::uuid[])`;
    await sql.end();
  }
});
