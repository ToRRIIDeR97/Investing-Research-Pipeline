// P4 (added in review, AC-1, AC-9): issuer resolution outcomes, the transient no-cache rule, the route's 400 on a
// malformed address, the pharma → B2 relabel and the SIC map's coverage.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureInputs as inputs, stubFetch } from "./support";

const yahoo = (instrumentType: string) => ({ chart: { result: [{ meta: { symbol: "X", currency: "USD", exchangeName: "NMS", instrumentType, exchangeTimezoneName: "America/New_York" } }], error: null } });
const secMap = { 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } };

test("AC-1: resolveIssuer — an SEC filer, a non-filer, an ETF, SEC down and Yahoo down", async () => {
  const { resolveIssuer, QuantInputError } = await import("../../../src/lib/quant/inputs");
  const sec = stubFetch([[/company_tickers/, secMap]]).fetchImpl;
  const equity = stubFetch([[/finance\/chart/, yahoo("EQUITY")]]).fetchImpl;

  const filer = await resolveIssuer("AAPL", { fetchImpl: sec, yahooFetch: equity });
  assert.equal(filer.cik, "0000320193");
  assert.deepEqual(filer.transient, []);

  const foreign = await resolveIssuer("SHOP", { fetchImpl: sec, yahooFetch: equity });
  assert.equal(foreign.cik, null);
  assert.match(foreign.notes.join(" "), /not an SEC filer/);

  await assert.rejects(resolveIssuer("SPY", { fetchImpl: sec, yahooFetch: stubFetch([[/finance\/chart/, yahoo("ETF")]]).fetchImpl }),
    (e: any) => e instanceof QuantInputError && e.code === "not_equity");

  const secDown = stubFetch([[/company_tickers/, new Response("busy", { status: 503 })]]).fetchImpl;
  await assert.rejects(resolveIssuer("AAPL", { fetchImpl: secDown, yahooFetch: equity }),
    (e: any) => e instanceof QuantInputError && e.code === "upstream_unavailable");

  const yahooDown = stubFetch([[/finance\/chart/, new Error("ECONNRESET")]]).fetchImpl;
  const noListing = await resolveIssuer("AAPL", { fetchImpl: sec, yahooFetch: yahooDown });
  assert.equal(noListing.cik, "0000320193");
  assert.deepEqual(noListing.transient, ["listing_type"]);

  await assert.rejects(resolveIssuer("ZZZZ", { fetchImpl: sec, yahooFetch: yahooDown }),
    (e: any) => e instanceof QuantInputError && e.code === "unknown_ticker");
});

test("AC-9: SEC unavailable maps to 503; a snapshot built during a transient failure is served but not cached", async () => {
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { QuantInputError } = await import("../../../src/lib/quant/inputs");
  const rows = new Map<string, unknown>();
  const store = { get: async (t: string, d: string) => (rows.get(`${t}|${d}`) as any) ?? null, put: async (s: any, d: string) => { rows.set(`${s.ticker}|${d}`, s); } };
  await assert.rejects(getQuantSnapshot("AAPL", { store, research: async () => null, load: async () => { throw new QuantInputError("upstream_unavailable", "SEC down"); } }),
    (e: any) => (e.statusCode ?? e.status) === 503);
  let loads = 0;
  const deps = { store, research: async () => null, now: new Date("2025-11-21T15:00:00Z"), load: async () => { loads++; return inputs({ transient: ["company_facts"] }); } };
  const first = await getQuantSnapshot("FIXA", deps);
  assert.equal(first.cached, false);
  assert.equal(rows.size, 0, "not cached");
  await getQuantSnapshot("FIXA", deps);
  assert.equal(loads, 2, "the next request retries");
});

test("AC-9: the route answers a malformed percent-encoded ticker with 400", async () => {
  const { GET } = await import("../../../src/app/api/quant/[ticker]/route");
  const request = { nextUrl: new URL("http://localhost/api/quant/%E0%A4%A") } as any;
  const response = await GET(request, { params: Promise.resolve({ ticker: "%E0%A4%A" }) });
  assert.equal(response.status, 400);
});

test("AC-5: SIC 2834–2836 pharma that is pre-revenue or loss-making is valued as Biotechnology (engine B2)", async () => {
  const { valuationIndustry } = await import("../../../src/lib/quant/sic");
  assert.equal(valuationIndustry("2834", "Drug Manufacturers—Specialty & Generic", 1e7, -5e7), "Biotechnology");
  assert.equal(valuationIndustry("2834", "Drug Manufacturers—Specialty & Generic", 5e9, 1e9), "Drug Manufacturers—Specialty & Generic");
  assert.equal(valuationIndustry("2836", "Biotechnology", 2e9, 3e8), "Biotechnology");
  assert.equal(valuationIndustry("7372", "Software—Application", 0, -1), "Software—Application");
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const base = inputs();
  const loss = { ...base, sic: "2834", sector: { sector: "Healthcare", industry: "Drug Manufacturers—Specialty & Generic", etf: "XLV" } } as any;
  loss.fundamentals = { ...loss.fundamentals, years: loss.fundamentals.years.map((y: any) => ({ ...y, values: { ...y.values, ebit: -Math.abs(y.values.ebit ?? 1e8) } })) };
  const snap = buildQuantSnapshot(loss, null, new Date("2025-11-21T15:00:00Z"));
  assert.equal(snap.value?.engine, "B2");
  assert.match(snap.notes.join(" "), /Biotechnology \(engine B2\)/);
});

test("AC-5: the SIC map covers 1000–1499 and 4900–4999, with gas transmission as midstream and 4950s as waste", async () => {
  const { sectorFromSic } = await import("../../../src/lib/quant/sic");
  for (let code = 1000; code <= 1499; code++) assert.notEqual(sectorFromSic(code).sector, "Unknown", `SIC ${code}`);
  for (let code = 4900; code <= 4999; code++) assert.notEqual(sectorFromSic(code).sector, "Unknown", `SIC ${code}`);
  assert.equal(sectorFromSic(4922).industry, "Oil & Gas Midstream");
  assert.equal(sectorFromSic(4923).sector, "Energy");
  assert.equal(sectorFromSic(4924).industry, "Utilities—Regulated Gas");
  assert.equal(sectorFromSic(4953).industry, "Waste Management");
  assert.equal(sectorFromSic(1040).industry, "Gold");
  assert.equal(sectorFromSic(1221).industry, "Thermal Coal");
});

test("AC-4: pattern detectors need volume only where they read it", async () => {
  const { detectPocketPivots, detectVcp } = await import("../../../src/lib/quant/trend/patterns");
  const bars = Array.from({ length: 300 }, (_, i) => ({ day: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    close: 100 + 10 * Math.sin(i / 9) + i * 0.1, high: 0, low: 0, volume: i < 100 ? null : 1_000_000 + (i % 7) * 50_000 })) as any[];
  assert.equal(detectPocketPivots(bars).status, "computed", "old bars without volume are outside the 90-day scan");
  assert.equal(detectVcp(bars).status, "computed", "old bars without volume are outside the 26-week window");
  const gap = bars.map((b, i) => (i === 280 ? { ...b, volume: null } : b));
  assert.equal(detectPocketPivots(gap).status, "unavailable");
  assert.equal(detectVcp(gap).status, "unavailable");
});

test("AC-4: safeFloat skips an empty string like Python's float('') did", async () => {
  const { safeFloat } = await import("../../../src/lib/quant/value/model");
  assert.equal(safeFloat({ a: "", b: 4 } as any, "a", "b"), 4);
  assert.equal(safeFloat({ a: "  " } as any, "a"), null);
});
