import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extractReleaseStatements, isResultsRelease, depositaryRatioFromText, scanTables } from "../src/lib/research/history/press-release";
import { statementObservations, reconcileFiledBalances } from "../src/lib/research/history/filing-statements";
import { quarterCoverage, MIN_FOREIGN_QUARTERS } from "../src/lib/research/history/filing-store";
import { dominantCurrency, reportingTaxonomy } from "../src/lib/research/history/sec-companyfacts";
import { isResultsCover, selectResearchFilings, fxSourcePayload, MAX_FOREIGN_UPDATES } from "../src/lib/research/sources/corpus";
import { equityBridge } from "../src/lib/research/valuation/engine";
import { valuationFinancialInputs } from "../src/lib/research/valuation/financial-inputs";
import { currencyConversion } from "../src/lib/research/valuation/v2";

const dir = new URL("./fixtures/jd/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const releases = readdirSync(dir).filter((f) => f.startsWith("release-")).sort();
const source = (id: string) => ({ id, url: `https://www.sec.gov/${id}`, published_at: "2026-08-13T00:00:00Z", period_end: "", metadata_json: { form: "6-K" } });
const capture = () => {
  const tables = releases.flatMap((name) => extractReleaseStatements(read(name), source(name), {}));
  return { tables, observations: statementObservations(tables) };
};
const quarterly = (rows: Record<string, any>[], key: string, end: string, segment?: string) => rows.find((o) => o.metric_key === key && o.period_end === end
  && o.periodicity === "quarterly" && (segment ? String(o.segment ?? "").includes(segment) : !o.segment))?.value_numeric;

test("JD's 6-K results releases give 12 quarters of statements and segment economics in RMB", () => {
  const { tables, observations } = capture();
  assert.deepEqual([...new Set(tables.map((t) => t.statement))].sort(), ["balance", "cashflow", "income", "segment"]);
  assert.equal(quarterly(observations, "revenue", "2026-03-31"), 315_694e6);
  assert.equal(quarterly(observations, "us_gaap_OperatingIncomeLoss", "2026-03-31", "New Businesses"), -10_352e6, "the burner segment");
  assert.equal(quarterly(observations, "us_gaap_OperatingIncomeLoss", "2026-03-31", "JD Retail"), 14_960e6);
  assert.equal(quarterly(observations, "operating_cash_flow", "2025-03-31"), -18_262e6, "parenthesised negatives across two cells");
  assert.ok(observations.every((o) => o.unit !== "USD" && o.currency !== "USD"), "US$ convenience translations are dropped");
  assert.ok(observations.filter((o) => o.metric_key === "revenue" && o.periodicity === "annual").length >= 2, "Q4 releases add full-year columns");
  const coverage = quarterCoverage(observations);
  assert.deepEqual([coverage.quarters, coverage.first, coverage.last, coverage.minimum], [12, "2023-09-30", "2026-06-30", MIN_FOREIGN_QUARTERS]);
  const checks = reconcileFiledBalances(tables);
  assert.ok(checks.filter((c) => c.status === "passed").length >= 14, "release balance sheets add up");
});

test("fewer than 12 release quarters falls short of the foreign-issuer minimum", () => {
  const two = releases.slice(-2).flatMap((name) => extractReleaseStatements(read(name), source(name), {}));
  assert.ok(quarterCoverage(statementObservations(two)).quarters < MIN_FOREIGN_QUARTERS);
});

test("6-Ks are chosen by content: the cover's exhibit index and the Ex-99.1 title", () => {
  assert.equal(isResultsCover(read("cover-results.htm")), true);
  assert.equal(isResultsCover(read("cover-buyback.htm")), false, "a share-repurchase announcement is skipped");
  for (const name of releases) assert.equal(isResultsRelease(read(name)), true, name);
  assert.equal(isResultsRelease("<p>JD.com Announces US$5.0 Billion New Share Repurchase Program</p>"), false);
  const s = JSON.parse(read("submissions.json")).filings.recent;
  const rows = s.form.map((form: string, i: number) => ({ form, filingDate: s.filingDate[i], reportDate: s.reportDate[i], accessionNumber: s.accessionNumber[i], primaryDocument: s.primaryDocument[i] }));
  const selected = selectResearchFilings(rows, "2021-01-01", "2026-09-30");
  assert.equal(selected.filter((f: any) => f.form === "6-K").length, Math.min(MAX_FOREIGN_UPDATES, rows.filter((r: any) => r.form === "6-K").length),
    "every 6-K in the window is a candidate, whatever its reportDate");
  assert.ok(selected.some((f: any) => f.form === "20-F" && f.filingFamily === "foreign_private_issuer"));
});

test("the ADS ratio is read from release text, and ambiguous text gives none", () => {
  assert.equal(depositaryRatioFromText(read("release-2026q1.htm")), 2);
  assert.equal(depositaryRatioFromText("<p>One American depositary share (“ADS”) represents 0.5 ordinary share.</p>"), 0.5);
  assert.equal(depositaryRatioFromText("each ADS representing two ordinary shares; each ADS representing eight ordinary shares"), null);
  assert.equal(depositaryRatioFromText("Diluted net income per ADS was RMB3.54"), null);
});

test("companyfacts gives the dominant reporting currency and taxonomy instead of assuming USD", () => {
  assert.equal(dominantCurrency(JSON.parse(read("companyfacts.json"))), "CNY");
  assert.equal(reportingTaxonomy(JSON.parse(read("companyfacts.json"))), "us-gaap");
  const ifrs = { facts: { "ifrs-full": { Revenue: { units: { EUR: [{ val: 1 }] } }, ProfitLoss: { units: { EUR: [{ val: 1 }] } } }, "us-gaap": { X: { units: { USD: [] } } } } };
  assert.deepEqual([dominantCurrency(ifrs), reportingTaxonomy(ifrs)], ["EUR", "ifrs-full"]);
  assert.equal(dominantCurrency({}), "USD");
});

test("the parser stays bounded on hostile markup", () => {
  const nested = "<table>".repeat(50_000) + "<tr><td>x".repeat(50_000);
  const start = Date.now();
  scanTables(nested);
  scanTables("<table><tr><td>Total net revenues<td>1".repeat(20_000));
  assert.ok(Date.now() - start < 2_000, "linear in the input");
  assert.ok(scanTables("<table><tr><td>a</td></tr></table>".repeat(500)).length <= 120, "table cap");
});

test("IFRS 16 lease liabilities join the equity bridge; US GAAP operating leases stay out", () => {
  const fi = (standard: "us-gaap" | "ifrs-full") => ({ currency: "EUR", units: "", basis: [], not_captured: [], price_cross_check: null, accounting_standard: standard,
    columns: ["period_end", "fiscal_year", "fiscal_quarter", "cash_and_equivalents", "long_term_debt", "operating_lease_liabilities", "lease_liabilities_ifrs"],
    quarterly: [["2026-06-30", 2026, 2, 100, 40, 30, 30]], annual: [] }) as any;
  const gaap = equityBridge(fi("us-gaap"))!, ifrs = equityBridge(fi("ifrs-full"))!;
  assert.equal(gaap.amount, 60);
  assert.deepEqual(gaap.excluded, { operating_lease_liabilities: 30 });
  assert.equal(ifrs.amount, 30, "cash 100 - debt 40 - IFRS 16 leases 30");
  assert.deepEqual(ifrs.excluded, {});
  const obs = (key: string, concept: string, value: number) => ({ metric_key: key, value_numeric: value, unit: "EUR", currency: "EUR", periodicity: "quarterly",
    period_end: "2026-06-30", fiscal_year: 2026, fiscal_quarter: 2, available_at: "2026-07-30", metadata_json: { concept } });
  const inputs = valuationFinancialInputs({ statementObservations: [obs("revenue", "ifrs-full:Revenue", 1e9), obs("ifrs_full_LeaseLiabilities", "ifrs-full:LeaseLiabilities", 3e8)], cutoff: new Date("2026-09-30") })!;
  assert.equal(inputs.accounting_standard, "ifrs-full");
  assert.ok(inputs.columns.includes("lease_liabilities_ifrs"));
});

test("a CNY reporter with a stored FX rate and ADS ratio is valued, not withheld", async () => {
  const conversion = currencyConversion({ statementCurrency: "CNY", priceCurrency: "USD", depositaryRatio: 2,
    fx: { series: "DEXCHUS", value: 7.1, observation_date: "2026-09-30", perUsd: true } });
  assert.deepEqual(conversion.missing, []);
  assert.equal(conversion.depositary_ratio, 2);
  assert.equal(currencyConversion({ statementCurrency: "CNY", priceCurrency: "USD", depositaryRatio: null, fx: null }).missing.length, 2, "without both it is withheld");
  const previous = process.env.RESEARCH_ACCEPTANCE_PROVIDER;
  delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
  try {
    const fetched: string[] = [];
    const fake = (async (url: string) => { fetched.push(url); return new Response("observation_date,DEXCHUS\n2026-09-29,7.12\n2026-09-30,7.10\n"); }) as any;
    const payload = await fxSourcePayload({ marketDataCutoffAt: "2026-09-30T00:00:00Z" } as any, "CNY", fake);
    assert.equal(payload?.metadata.series_id, "DEXCHUS", "the valuation finds the document by series_id");
    assert.deepEqual(fetched, ["https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXCHUS"]);
    assert.equal(await fxSourcePayload({} as any, "USD", fake), null, "no FX document for a USD reporter");
  } finally { if (previous !== undefined) process.env.RESEARCH_ACCEPTANCE_PROVIDER = previous; }
});
