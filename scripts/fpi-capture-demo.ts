/**
 * Deterministic foreign-issuer capture demo, no database or network: reads stored JD.com fixtures (6-K results
 * releases, a 6-K cover per kind, trimmed submissions and companyfacts) and prints what the pipeline would capture:
 * which 6-Ks it keeps, the quarterly table with segment economics, quarter coverage against the 12-quarter minimum,
 * the ADS ratio, the reporting currency and the FX series the valuation would use.
 *
 *   npx tsx scripts/fpi-capture-demo.ts [fixture-dir]     (default tests/fixtures/jd)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractReleaseStatements, depositaryRatioFromText, isResultsRelease } from "../src/lib/research/history/press-release";
import { statementObservations, reconcileFiledBalances } from "../src/lib/research/history/filing-statements";
import { quarterCoverage } from "../src/lib/research/history/filing-store";
import { dominantCurrency, reportingTaxonomy } from "../src/lib/research/history/sec-companyfacts";
import { isResultsCover, selectResearchFilings } from "../src/lib/research/sources/corpus";
import { fxSeriesFor } from "../src/lib/research/valuation/v2";
import { valuationFinancialInputs } from "../src/lib/research/valuation/financial-inputs";
import { equityBridge } from "../src/lib/research/valuation/engine";

const dir = resolve(process.argv[2] ?? "tests/fixtures/jd");
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const files = readdirSync(dir);

const submissions = JSON.parse(read("submissions.json"));
const r = submissions.filings.recent;
const rows = r.form.map((form: string, i: number) => ({ form, filingDate: r.filingDate[i], reportDate: r.reportDate[i], accessionNumber: r.accessionNumber[i], primaryDocument: r.primaryDocument[i], items: r.items[i] }));
const selected = selectResearchFilings(rows, "2021-01-01", "2026-09-30");
console.log(`Submissions: ${rows.length} 20-F/6-K rows since 2024-08; selected ${selected.filter((f: any) => f.form === "20-F").length} 20-F and ${selected.filter((f: any) => f.form === "6-K").length} 6-K candidates.`);
for (const cover of files.filter((f) => f.startsWith("cover-"))) console.log(`  ${cover}: ${isResultsCover(read(cover)) ? "results release, kept" : "not a results release, skipped"}`);

const companyFacts = JSON.parse(read("companyfacts.json"));
const currency = dominantCurrency(companyFacts);
console.log(`Reporting currency ${currency} (${reportingTaxonomy(companyFacts)}); FX series for a USD price: FRED ${fxSeriesFor(currency, "USD")?.series ?? "none"}.`);

const releases = files.filter((f) => f.startsWith("release-")).sort();
const tables = releases.flatMap((name, i) => {
  const html = read(name);
  if (!isResultsRelease(html)) throw new Error(`${name} is not a results release`);
  return extractReleaseStatements(html, { id: name, url: name, published_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, period_end: "", metadata_json: { form: "6-K" } }, {});
});
const ratio = releases.map((name) => depositaryRatioFromText(read(name))).find((v) => v !== null) ?? null;
console.log(`ADS ratio: ${ratio ?? "not stated"} ordinary shares per ADS.`);

const observations = statementObservations(tables);
const value = (key: string, end: string, segment?: string) => observations.find((o) => o.metric_key === key && o.period_end === end && o.periodicity === "quarterly"
  && (segment ? String(o.segment ?? "").includes(segment) : !o.segment))?.value_numeric;
const bn = (v: number | undefined) => v === undefined || v === null ? "-" : (v / 1e9).toFixed(1);
const ends = [...new Set(observations.filter((o) => o.metric_key === "revenue" && !o.segment && o.periodicity === "quarterly").map((o) => String(o.period_end)))].sort();
console.log(`\nQuarter      Revenue  OpInc  Retail OI  Logistics OI  New Bus. OI  OCF   (RMB bn)`);
for (const end of ends) {
  console.log([end.padEnd(11), bn(value("revenue", end)).padStart(8), bn(value("us_gaap_OperatingIncomeLoss", end)).padStart(6),
    bn(value("us_gaap_OperatingIncomeLoss", end, "JD Retail")).padStart(10), bn(value("us_gaap_OperatingIncomeLoss", end, "JD Logistics")).padStart(13),
    bn(value("us_gaap_OperatingIncomeLoss", end, "New Businesses")).padStart(12), bn(value("operating_cash_flow", end)).padStart(5)].join(" "));
}
const coverage = quarterCoverage(observations);
const checks = reconcileFiledBalances(tables);
console.log(`\nQuarter coverage: ${coverage.quarters} quarters (${coverage.first} to ${coverage.last}); minimum ${coverage.minimum}: ${coverage.quarters >= coverage.minimum ? "passes" : "fails"}.`);
console.log(`Balance checks: ${checks.filter((c) => c.status === "passed").length} passed, ${checks.filter((c) => c.status !== "passed").length} unconfirmed (a release can omit a line the filed balance sheet has).`);

// The equity bridge the valuation would use, per ADS in the reporting currency (FX is applied in the valuation).
const inputs = valuationFinancialInputs({ statementObservations: observations, cutoff: new Date("2026-09-30") });
const bridge = equityBridge(inputs);
const diluted = companyFacts.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding?.units?.shares?.filter((x: any) => x.form === "20-F").at(-1);
if (bridge && diluted && ratio) {
  const perAds = (amount: number) => (amount / (diluted.val / 1e6 / ratio)).toFixed(2);
  console.log(`\nEquity bridge at ${bridge.period_end} (${currency} millions): ${Object.entries(bridge.components).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  console.log(`Bridge ${bridge.amount} = ${currency} ${perAds(bridge.amount)} per ADS on ${(diluted.val / 1e6).toFixed(0)}m diluted ordinary shares (FY${diluted.fy}) and ${ratio} shares per ADS.`);
}
