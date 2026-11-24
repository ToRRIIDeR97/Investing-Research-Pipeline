// Review round 2 (AC-3, AC-4, AC-5, AC-9, AC-10): price-sync and submissions failures, mining routing, the narrowest
// SIC range, Python-exact rounding, ordinals, money formatting and the ticker page's stale and refresh-error states.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureInputs, read, stubFetch } from "./support";

test("AC-9: a failed price sync is 503 with no stored bars, transient over stored bars, 404 when the provider has none", async () => {
  const { priceSyncOutcome, QuantInputError } = await import("../../../src/lib/quant/inputs");
  assert.throws(() => priceSyncOutcome("AAPL", false, 0), (e: any) => e instanceof QuantInputError && e.code === "upstream_unavailable");
  assert.throws(() => priceSyncOutcome("AAPL", true, 0), (e: any) => e instanceof QuantInputError && e.code === "no_prices");
  assert.deepEqual(priceSyncOutcome("AAPL", false, 500).transient, ["prices"]);
  assert.deepEqual(priceSyncOutcome("AAPL", true, 500), { notes: [], transient: [] });
  // And the snapshot built from transient prices is served but not stored.
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  const rows = new Map<string, unknown>();
  const store = { get: async (t: string, d: string) => (rows.get(`${t}|${d}`) as any) ?? null, put: async (s: any, d: string) => { rows.set(`${s.ticker}|${d}`, s); } };
  await getQuantSnapshot("FIXA", { store, research: async () => null, load: async () => fixtureInputs({ transient: ["prices"] }) as any });
  assert.equal(rows.size, 0);
});

test("AC-9: an SEC submissions failure after the CIK resolved is 503, not a raw 500", async () => {
  const { fetchSubmissions, QuantInputError } = await import("../../../src/lib/quant/inputs");
  const down = stubFetch([[/submissions/, new Response("busy", { status: 503 })]]).fetchImpl;
  await assert.rejects(fetchSubmissions("0000320193", down), (e: any) => e instanceof QuantInputError && e.code === "upstream_unavailable");
  const ok = stubFetch([[/submissions\/CIK0000320193\.json/, { name: "Apple Inc.", sic: "3571" }]]).fetchImpl;
  assert.equal((await fetchSubmissions("0000320193", ok)).name, "Apple Inc.");
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  const store = { get: async () => null, put: async () => {} };
  await assert.rejects(getQuantSnapshot("AAPL", { store, research: async () => null, load: async () => fetchSubmissions("1", down) as any }),
    (e: any) => (e.statusCode ?? e.status) === 503);
});

test("AC-3: SIC 1000–1499 (gold, metals, coal, oil and gas, non-metallic minerals) is valued with engine F", async () => {
  const { valuationEngine, sectorFromSic } = await import("../../../src/lib/quant/sic");
  for (const code of [1000, 1040, 1094, 1221, 1311, 1381, 1400, 1499]) assert.equal(valuationEngine(code), "F", `SIC ${code}`);
  for (const code of [999, 1500, 2834, 7372, null]) assert.equal(valuationEngine(code as any), null);
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const gold = buildQuantSnapshot({ ...fixtureInputs(), sic: "1040", sector: sectorFromSic(1040) } as any, null, new Date("2025-11-21T15:00:00Z"));
  assert.equal(gold.industry, "Gold");
  assert.equal(gold.value?.engine, "F");
});

test("AC-5: the narrowest SIC range wins over the broad range around it", async () => {
  const { sectorFromSic } = await import("../../../src/lib/quant/sic");
  assert.equal(sectorFromSic(2086).industry, "Beverages—Non-Alcoholic");
  assert.equal(sectorFromSic(2010).industry, "Packaged Foods");
  assert.equal(sectorFromSic(3634).industry, "Furnishings, Fixtures & Appliances");
  assert.equal(sectorFromSic(3674).industry, "Semiconductors");
  assert.equal(sectorFromSic(6324).industry, "Healthcare Plans");
  assert.equal(sectorFromSic(6331).industry, "Insurance—Property & Casualty");
  assert.equal(sectorFromSic(7372).industry, "Software—Application");
  assert.equal(sectorFromSic(5961).industry, "Internet Retail");
  for (const code of [2830, 2831, 2832, 2837, 2838, 2839]) assert.equal(sectorFromSic(code).sector, "Healthcare", `SIC ${code}`);
});

test("AC-4: pyRound matches Python's round on exact decimal ties", async () => {
  const { pyRound } = await import("../../../src/lib/quant/value/model");
  // Values from CPython 3.12: round(x, n).
  const cases: [number, number, number][] = [[2.675, 2, 2.67], [1.115, 2, 1.11], [0.125, 2, 0.12], [0.375, 2, 0.38], [-2.675, 2, -2.67],
    [1234.5678, 3, 1234.568], [9.995, 2, 9.99], [2.5, 0, 2], [3.5, 0, 4], [-0.5, 0, -0], [1.5e-7, 7, 1e-7], [0.285, 2, 0.28], [1.005, 2, 1]];
  for (const [x, n, want] of cases) assert.equal(pyRound(x, n), want, `round(${x}, ${n})`);
});

test("AC-10: percentiles read as ordinals, and money text handles negatives consistently", async () => {
  const c = await import("../../../src/components/quant/quant-charts");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100, 101, 111].map(c.ordinal),
    ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "100th", "101st", "111th"]);
  const html = renderToStaticMarkup(<c.MultipleBand points={[{ period: "2022-12-31", multiple: 10 }, { period: "2023-12-31", multiple: 12 }]} metric="P/E" p25={9} p75={13} current={12} percentile={22} />);
  assert.match(html, /22nd percentile/);
  assert.doesNotMatch(html, /\d+th pct|22th/);
  assert.equal(c.money(-3.2), "−$3.20");
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { QuantView } = await import("../../../src/components/quant/quant-view");
  const s = buildQuantSnapshot(fixtureInputs(), null, new Date("2025-11-21T15:00:00Z"));
  const neg = { ...s, value: { ...s.value!, dcf: { ...s.value!.dcf, intrinsic_value_bear: -3.2 } } };
  const out = renderToStaticMarkup(<QuantView snapshot={neg as any} tab="value" onTab={() => {}} />);
  assert.match(out, /−\$3\.20/);
  assert.doesNotMatch(out, /\$-/);
});

test("AC-10: a failed refresh keeps the snapshot and reports it; the ticker page remounts per ticker", async () => {
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { QuantView } = await import("../../../src/components/quant/quant-view");
  const s = buildQuantSnapshot(fixtureInputs(), null, new Date("2025-11-21T15:00:00Z"));
  const html = renderToStaticMarkup(<QuantView snapshot={s} tab="value" onTab={() => {}} onRefresh={() => {}} refreshError="SEC filings could not be fetched." />);
  // Wording updated in round 3 ("Refresh failed (reason).").
  assert.match(html, /role="alert"><p[^>]*>Refresh failed \(SEC filings could not be fetched\)\. The figures below/);
  assert.match(html, /PQ-Grade/, "the snapshot is still shown");
  const page = read("src/app/quant/[ticker]/page.tsx");
  // Keyed by the decoded, upper-cased ticker since round 3.
  assert.match(page, /<QuantTicker key=\{key\}/, "a new ticker remounts the view, clearing the old snapshot");
  assert.match(page, /key = decodeURIComponent\(ticker\)\.trim\(\)\.toUpperCase\(\)/);
  assert.match(page, /setRefreshError/);
  assert.match(page, /href="\/quant"/, "the error state links back to the search");
  // The finder moved into a component in the design-system change; it still validates typed tickers.
  assert.match(read("src/components/quant/quant-finder.tsx"), /TICKER_PATTERN\.test/);
});
