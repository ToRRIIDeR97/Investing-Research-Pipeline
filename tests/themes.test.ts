// Theme research beyond the acceptance set: SEC's SIC page parsing, ranking ties and nulls, ownership text, request
// cleaning, and the mock model's outputs passing the pipeline's contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ThemeRequest, ownershipOptions, parseSicCompanies, rankCandidates, scorecardRow } from "../src/lib/research/themes";
import { CANDIDATES_CONTRACT, FRAMING_CONTRACT, SIC_CONTRACT } from "../src/lib/research/themes/pipeline";
import { MockProvider } from "../src/lib/agent-harness/providers/mock";

test("SIC company pages yield CIKs and plain names only", () => {
  const html = `<table><tr><th>CIK</th><th>Company</th></tr>
    <tr><td><a href="/cgi-bin/browse-edgar?action=getcompany&CIK=0001050915&owner=include">0001050915</a></td><td>QUANTA <b>SERVICES</b>, INC. &amp; co</td></tr>
    <tr><td><a href="/cgi-bin/browse-edgar?action=getcompany&CIK=15615">15615</a></td><td><script>alert(1)</script>MASTEC</td></tr>
    <tr><td>no link</td><td>Ignored</td></tr></table>`;
  assert.deepEqual(parseSicCompanies(html), [{ cik: "0001050915", name: "QUANTA SERVICES , INC. & co" }, { cik: "0000015615", name: "alert(1) MASTEC" }]);
  assert.deepEqual(parseSicCompanies("not html"), []);
});

test("ranking: ties share their position, nulls rank lowest, all-null factors give 0", () => {
  const rows = [{ ticker: "A", growth: 0.1, quality: null, value: null, balance_sheet: null }, { ticker: "B", growth: 0.1, quality: null, value: null, balance_sheet: null },
    { ticker: "C", growth: 0.3, quality: null, value: null, balance_sheet: null }, { ticker: "D", growth: null, quality: null, value: null, balance_sheet: null }];
  const ranked = rankCandidates(rows, { growth: 1, quality: 0, value: 0, balance_sheet: 0 });
  assert.deepEqual(ranked.map((r) => [r.ticker, r.score]), [["C", 100], ["A", 25], ["B", 25], ["D", 0]]);
});

test("the scorecard prefers LongTermDebt and falls back to LongTermDebtNoncurrent; duration facts outside a year are ignored", () => {
  const fy = (y: number, val: number, start = `${y}-01-01`) => ({ start, end: `${y}-12-31`, val, fy: y, fp: "FY", form: "10-K", filed: `${y + 1}-02-01` });
  const inst = (y: number, val: number) => ({ end: `${y}-12-31`, val, fy: y, fp: "FY", form: "10-K", filed: `${y + 1}-02-01` });
  const row = scorecardRow({ facts: { "us-gaap": {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [fy(2024, 100), fy(2025, 120), fy(2025, 999, "2025-10-01")] } },
    LongTermDebtNoncurrent: { units: { USD: [inst(2025, 80)] } } } } }, 10);
  assert.deepEqual([row.revenue, row.net_debt, row.revenue_cagr_5y, row.pe_ttm], [120, 80, null, null]);
  assert.ok(Math.abs(row.revenue_growth_1y! - 0.2) < 1e-9);
});

test("ownership options and request cleaning", () => {
  const options = ownershipOptions([{ ticker: "PWR", score: 90 }, { ticker: "HUBB", score: 70 }], ["GRID"]);
  assert.deepEqual(options.map((o) => o.kind), ["basket", "leader", "etf"]);
  assert.match(options[0].text, /PWR, HUBB in equal weights \(50% each\)/);
  assert.match(options[2].text, /GRID/);
  const parsed = ThemeRequest.parse({ theme: "  Grid\n  build-out ", horizon_years: 10, roles: ["supplier"], min_exposure: 0, us_only: false,
    objectives: { growth: 1, quality: 0, value: 0, balance_sheet: 0 }, tickers: [" pwr ", "brk.b"] });
  assert.deepEqual([parsed.theme, parsed.tickers], ["Grid build-out", ["PWR", "BRK.B"]]);
  assert.ok(!ThemeRequest.safeParse({ ...parsed, tickers: ["DROP TABLE"] }).success);
  assert.ok(!ThemeRequest.safeParse({ ...parsed, roles: ["supplier", "supplier"] }).success);
});

async function mock(packet: Record<string, unknown>) {
  let text = "";
  for await (const event of new MockProvider().stream({ model: "mock", agentName: "asset-analyst", prompt: JSON.stringify(packet) }, new AbortController().signal))
    if (event.type === "text.delta") text += event.text;
  return JSON.parse(text);
}

test("the mock model's theme outputs pass the pipeline's contracts, and its two lists overlap", async () => {
  assert.deepEqual(FRAMING_CONTRACT.validate!(await mock({ output_contract: "theme_framing" })), []);
  assert.deepEqual(SIC_CONTRACT.validate!(await mock({ output_contract: "theme_sic" })), []);
  const suppliers = await mock({ output_contract: "theme_candidates", angle: "suppliers" }), leaders = await mock({ output_contract: "theme_candidates", angle: "leaders" });
  assert.deepEqual(CANDIDATES_CONTRACT.validate!(suppliers), []);
  assert.deepEqual(CANDIDATES_CONTRACT.validate!(leaders), []);
  const overlap = suppliers.candidates.map((c: { ticker: string }) => c.ticker).filter((t: string) => leaders.candidates.some((c: { ticker: string }) => c.ticker === t));
  assert.deepEqual(overlap, ["PWR", "HUBB", "ETN"]);
});
