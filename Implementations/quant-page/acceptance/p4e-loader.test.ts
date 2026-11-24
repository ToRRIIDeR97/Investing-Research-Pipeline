// Review round 4 (AC-1, AC-2, AC-9): loadQuantInputs end to end, with SEC and Yahoo stubbed and the database calls
// replaced by an in-memory QuantIo, so the wiring from each upstream outcome to `transient` and the error codes is
// exercised through the real loader, then through getQuantSnapshot's cache rule.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubFetch } from "./support";

delete process.env.XBRL_WAREHOUSE_URL; // companyfacts comes from the stubbed SEC endpoint

const DAY = 86_400_000;
function storedBars(n: number, symbol: string) {
  const out: any[] = [];
  for (let i = 0, t = Date.UTC(2024, 0, 1); out.length < n; t += DAY) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const day = d.toISOString().slice(0, 10);
    out.push({ id: `${symbol}-${i}`, day, close: 100 + 10 * Math.sin(i / 15) + i * 0.05, adjusted_close: null, currency: "USD", provider_symbol: symbol,
      retrieved_day: day, available_at: day, verification_status: "verified", verification_json: {}, volume: 1_000_000 + (i % 9) * 40_000 });
    i++;
  }
  return out;
}

type Outcome = { prices?: "synced" | "failed"; storedCount?: number; spx?: "synced" | "failed"; etf?: "synced" | "failed" | "throws" };
function fakeIo(o: Outcome) {
  const calls: string[] = [];
  const io = {
    asset: async (ticker: string, name: string) => { calls.push(`asset ${ticker} ${name}`); return { id: "asset-q", name, researched: false }; },
    syncPrices: async () => { calls.push("syncPrices"); return { status: o.prices ?? "synced" }; },
    storedPrices: async () => ({ bars: storedBars(o.storedCount ?? 320, "X"), splits: [] }),
    syncBenchmark: async () => ({ status: o.spx ?? "synced" }),
    storedBenchmark: async () => ({ bars: storedBars(320, "^GSPC"), splits: [] }),
    sectorEtf: async (symbol: string) => {
      calls.push(`etf ${symbol}`);
      if (o.etf === "throws") throw new Error("db down");
      return { etf: { symbol, bars: storedBars(320, symbol).map((b) => ({ day: b.day, close: b.close, volume: b.volume })) }, synced: o.etf !== "failed" };
    },
  };
  return { io, calls };
}

const yahoo = { chart: { result: [{ meta: { symbol: "ACME", currency: "USD", exchangeName: "NMS", instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York" } }], error: null } };
const routes = (over: Array<[RegExp, unknown]> = []) => stubFetch([
  ...over,
  [/finance\/chart/, yahoo],
  [/company_tickers/, { 0: { cik_str: 1234, ticker: "ACME", title: "Acme Corp" } }],
  [/submissions\/CIK0000001234\.json/, { name: "Acme Corp", sic: "7372", sicDescription: "Prepackaged software", filings: { recent: { form: [], accessionNumber: [], filingDate: [] } } }],
  [/companyfacts/, new Response("busy", { status: 503 })],
]).fetchImpl;

const load = async (o: Outcome, over: Array<[RegExp, unknown]> = []) => {
  const { loadQuantInputs } = await import("../../../src/lib/quant/inputs");
  const { io, calls } = fakeIo(o);
  const inputs = await loadQuantInputs(null as any, "acme", { fetchImpl: routes(over), now: new Date("2025-03-01T12:00:00Z"), io });
  return { inputs, calls };
};

test("AC-1/AC-9: a filer with SEC companyfacts down loads prices and benchmarks, and marks only companyfacts transient", async () => {
  const { inputs, calls } = await load({});
  assert.equal(inputs.ticker, "ACME");
  assert.equal(inputs.name, "Acme Corp");
  assert.equal(inputs.cik, "0000001234");
  assert.equal(inputs.sector.etf, "XLK");
  assert.equal(inputs.fundamentals, null);
  assert.match(inputs.fundamentals_reason!, /companyfacts could not be fetched/);
  assert.deepEqual(inputs.transient, ["companyfacts"]);
  assert.equal(inputs.bars.length, 320);
  assert.equal(inputs.sector_etf?.symbol, "XLK");
  assert.ok(calls.includes("asset ACME Acme Corp") && calls.includes("etf XLK"));
});

test("AC-9: price, S&P 500 and sector-ETF failures over stored bars all reach `transient`, and the snapshot isn't cached", async () => {
  const { inputs } = await load({ prices: "failed", spx: "failed", etf: "throws" });
  assert.deepEqual(inputs.transient, ["companyfacts", "prices", "benchmark", "sector_etf"]);
  assert.equal(inputs.sector_etf, null);
  assert.ok(inputs.notes.some((n) => /stored prices were used/.test(n)));
  assert.ok(inputs.notes.some((n) => /S&P 500 only/.test(n)));
  assert.ok(!inputs.notes.some((n) => /busy|db down|503/.test(n)), "no upstream error text in the notes");
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  let puts = 0;
  const r = await getQuantSnapshot("ACME", { store: { get: async () => null, put: async () => { puts++; } }, research: async () => null, load: async () => inputs });
  assert.equal(r.cached, false);
  assert.equal(puts, 0);
  const etfStale = await load({ etf: "failed" });
  assert.deepEqual(etfStale.inputs.transient, ["companyfacts", "sector_etf"]);
  assert.equal(etfStale.inputs.sector_etf?.symbol, "XLK", "stored ETF bars are still used");
});

test("AC-9: a failed price sync with nothing stored is 503; a working sync with nothing stored is 404", async () => {
  const { QuantInputError } = await import("../../../src/lib/quant/inputs");
  await assert.rejects(load({ prices: "failed", storedCount: 0 }), (e: any) => e instanceof QuantInputError && e.code === "upstream_unavailable");
  await assert.rejects(load({ prices: "synced", storedCount: 0 }), (e: any) => e instanceof QuantInputError && e.code === "no_prices");
});

test("AC-9: SEC submissions down after the CIK resolved is 503 before any price work", async () => {
  const { QuantInputError } = await import("../../../src/lib/quant/inputs");
  await assert.rejects(load({}, [[/submissions/, new Response("busy", { status: 503 })]]), (e: any) => e instanceof QuantInputError && e.code === "upstream_unavailable");
});

test("AC-1: a non-filer is partial (Value unavailable) and an ETF listing is refused before any storage call", async () => {
  const foreign = await load({}, [[/company_tickers/, { 0: { cik_str: 1, ticker: "OTHER" } }]]);
  assert.equal(foreign.inputs.cik, null);
  assert.equal(foreign.inputs.fundamentals_reason, "Not an SEC filer.");
  assert.deepEqual(foreign.inputs.transient, []);
  const { loadQuantInputs, QuantInputError } = await import("../../../src/lib/quant/inputs");
  const { io, calls } = fakeIo({});
  const etf = stubFetch([[/finance\/chart/, { chart: { result: [{ meta: { ...yahoo.chart.result[0].meta, instrumentType: "ETF" } }], error: null } }]]).fetchImpl;
  await assert.rejects(loadQuantInputs(null as any, "SPY", { fetchImpl: etf, io }), (e: any) => e instanceof QuantInputError && e.code === "not_equity");
  assert.deepEqual(calls, [], "nothing stored for a refused ticker");
});
