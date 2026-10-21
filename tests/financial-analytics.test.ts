import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FinancialAnalytics, analyticsDigest, buildFinancialAnalytics, tableRows, type AnalyticsTable } from "../src/lib/research/history/analytics";
import { buildStatementSummary } from "../src/lib/research/history/statement-summary";
import { fillMonitoringLevels } from "../src/lib/research/decision/monitoring-levels";
import { buildReportFacts } from "../src/lib/research/reporting/facts";
import { researchPacketForModel } from "../src/lib/research/reporting/packet";

// META statement lines (run 4fae0fb1, filings to 2026-06-30) and period-end market caps.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/meta-statements.json", import.meta.url), "utf8"));
const observations = fixture.rows.map((row: unknown[]) => Object.fromEntries(fixture.columns.map((c: string, i: number) => [c, row[i]])))
  .map((r: Record<string, any>) => ({ ...r, currency: /^[A-Z]{3}$/.test(r.unit) ? r.unit : null,
    metadata_json: r.statement ? { statement: r.statement } : { metric_category: "market_data" } }));
const pack = FinancialAnalytics.parse(buildFinancialAnalytics({ observations, endFiscalYear: 2026, endFiscalQuarter: 2 }));
const at = (table: AnalyticsTable, period = "2026Q2") => tableRows(table).find((row) => row.period === period)!;
const stat = (metric: string) => tableRows(pack.statistics).find((row) => row.metric === metric)!;

test("the META pack reproduces the review's figures", () => {
  assert.deepEqual(pack.window, { start: "2021Q3", end: "2026Q2", quarters: 20 });
  const members = tableRows(pack.segments.members);
  const labs = members.find((m) => m.segment === "RealityLabs")!, apps = members.find((m) => m.segment === "FamilyOfApps")!;
  assert.equal(labs.cumulative_operating_income, -81340);
  assert.equal(labs.quarters_with_operating_income, 20);
  assert.equal(labs.role, "burner");
  assert.equal(apps.cumulative_operating_income, 374346);
  assert.equal(apps.role, "earner");
  assert.equal(at(pack.working_capital.quarterly).dso, 34.8);
  assert.equal(at(pack.working_capital.quarterly).payables_basis, "total");
  assert.ok(pack.working_capital.notes.some((n) => /trade to total/.test(n)), "the payables concept switch is flagged");
  const capital = at(pack.capital_allocation.quarterly);
  assert.equal(capital.net_cash, 6596);
  assert.equal(capital.shares, 2548);
  assert.equal(capital.shares_yoy, 0.0127);
  assert.equal(capital.buyback_yield, 0.0023);
  assert.deepEqual(tableRows(pack.capital_allocation.share_classes).map((c) => [c.class, c.shares]), [["CommonClassA", 2206], ["CommonClassB", 342]]);
  const cash = at(pack.cash_conversion.quarterly);
  assert.equal(cash.fcf_ttm, 40976);
  assert.equal(cash.fcf_to_net_income, 0.6017);
  assert.equal(cash.capex_to_da, 3.93);
  assert.equal(stat("fcf_to_net_income").percentile, 0.06, "lowest of 16 quarters");
  assert.equal(stat("segment.FamilyOfApps.operating_margin").percentile, 0.15);
  assert.equal(stat("revenue_yoy").latest, 0.2796);
  assert.equal(stat("revenue_yoy").n, 16);
  assert.equal(pack.tax_rate.normalized, 0.1585);
  assert.equal(tableRows(pack.cash_conversion.incremental)[0].incremental_roic, 0.0889);
  // Reality Labs losses as a share of Family of Apps operating income, FY2021-FY2025.
  assert.deepEqual(tableRows(pack.segments.annual).filter((r) => r.segment === "RealityLabs").map((r) => r.loss_to_earner_operating_income),
    [0.179, 0.3215, 0.2564, 0.2035, 0.1873]);
  assert.ok(pack.derived_quarters.some((n) => /Q3 2025 is the FY2025 total/.test(n)), "the derived 2025Q3 cash flows are listed");
});

test("the digest fits the cached prefix and the full pack fits a report packet", () => {
  const digest = analyticsDigest(pack, "artifact-1");
  const digestBytes = JSON.stringify(digest).length, packBytes = JSON.stringify(pack).length;
  assert.ok(digestBytes >= 8_000 && digestBytes <= 12_000, `digest is ${digestBytes} bytes`);
  assert.ok(packBytes <= 25_000, `pack is ${packBytes} bytes`);
  assert.equal(digest.quarterly.rows.length, 8);
  assert.equal(digest.segments.quarterly.rows.length, 16);
  assert.equal(digest.statistics.rows.length, pack.statistics.rows.length);
  assert.deepEqual(researchPacketForModel({ financial_analytics: digest }).financial_analytics, digest, "the packet view leaves it unchanged");
});

test("monitoring levels come from the pack by metric_key, in the KPI's unit, with history", () => {
  const items: Record<string, any>[] = [
    { kpi: "Operating margin", metric_key: "operating_margin_gaap_quarterly", unit: "ratio", current_level: 0.309, source_role: "Q2 10-Q" },
    { kpi: "Capex intensity", metric_key: "capex_pct_revenue_quarterly", unit: "%", current_level: 49.5, source_role: "Q2 10-Q" },
    { kpi: "Reality Labs loss", metric_key: "reality_labs_operating_loss_quarterly", unit: "USD millions", current_level: -4619, source_role: "model" },
    { kpi: "Reality Labs loss (positive)", metric_key: "reality_labs_operating_loss", unit: "USD millions", current_level: 4619, source_role: "model" },
    { kpi: "Diluted share count", metric_key: "us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding", unit: "million shares", current_level: 2500, source_role: "model" },
    { kpi: "Ad impressions", metric_key: "ad_impressions_yoy_growth", unit: "ratio", current_level: 0.1, source_role: "stale" },
  ];
  const filled = fillMonitoringLevels(items, { analytics: pack, latestReported: [
    { metric_key: "us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding", value_numeric: 2_597_000_000, unit: "shares", fiscal_year: 2026, fiscal_quarter: 2 },
    { metric_key: "us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding", segment: "us-gaap:CommonClassAMember", value_numeric: 1, unit: "shares" },
  ] });
  assert.deepEqual(items[0], { ...items[0], current_level: 0.3088, history_median: 0.3795, history_percentile: 0.35, source_role: "financial_analytics operating_margin 2026Q2" });
  assert.equal(items[1].current_level, 49.53);
  assert.equal(items[2].current_level, -4619);
  assert.equal(items[2].source_role, "financial_analytics segment.RealityLabs.operating_income 2026Q2");
  assert.equal(items[3].current_level, 4619, "a KPI stated with the opposite sign keeps the model's level");
  assert.equal(items[4].current_level, 2597);
  assert.equal(items[5].current_level, null, "a stale level the code cannot fill is cleared");
  assert.deepEqual(filled, ["operating_margin_gaap_quarterly", "capex_pct_revenue_quarterly", "reality_labs_operating_loss_quarterly",
    "us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding"]);
});

test("report_facts computes present values, terminal share, yields and the no-rerating return from stored schedules", () => {
  const table = (columns: string[], rows: unknown[][]) => ({ columns, rows });
  const empty = table([], []);
  const small = FinancialAnalytics.parse({ ...pack, statistics: empty, quarterly: empty, segments: { members: empty, quarterly: empty, annual: empty },
    cash_conversion: { quarterly: table(["period", "fcf_ttm", "nopat_ttm"], [["2026Q2", 80, 95]]), incremental: empty },
    capital_allocation: { quarterly: table(["period", "sbc_ttm"], [["2026Q2", 10]]), share_classes: empty, notes: [] } });
  const schedule = (scenario_type: string) => ({ method: "fcff", method_name: "DCF", scenario_type, rationale: "r", currency: "USD", cash_flow_label: "FCFF",
    discount_rate: 0.1, years: [
      { fiscal_year: 2027, cash_flow: 110, build: { starting_profit: 100, depreciation_amortization: 20, capital_expenditures: 10, change_in_net_working_capital: 0, other_adjustments: 0 } },
      { fiscal_year: 2028, cash_flow: 121, build: { starting_profit: 110, depreciation_amortization: 21, capital_expenditures: 10, change_in_net_working_capital: 0, other_adjustments: 0 } }],
    terminal: { type: "multiple", metric: "nopat", metric_value: 110, multiple: 10 }, equity_bridge: 50, equity_bridge_explanation: "cash", diluted_shares: 10, source_notes: ["n"] });
  const facts = buildReportFacts([
    { artifact_type: "financial_analytics", content_json: small },
    { artifact_type: "valuation_scenario_set", content_json: { artifact_type: "valuation_scenario_set", terminal_year: 2028, current_market_price: 100,
      terminal_anchor_bear: 120, terminal_anchor_base: 130, terminal_anchor_bull: 140, probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25,
      method_inputs: ["bear", "base", "bull"].map(schedule) } },
  ])!;
  const base = tableRows(facts.cases as any).find((c) => c.case === "base")!;
  assert.equal(base.pv_per_share, 115.91);
  assert.equal(base.return_to_pv, 0.1591);
  assert.equal(base.tv_share_of_ev, 0.8197);
  assert.equal(base.explicit_cash_flow_sum, 231);
  assert.equal(base.undiscounted_return_to_terminal, 0.3);
  assert.equal(base.no_rerating_return, 0.381);
  assert.equal(base.no_rerating_return_annualized, 0.1752);
  assert.deepEqual(facts.weighted, { pv_per_share: 115.91, return_to_pv: 0.1591 });
  assert.equal(facts.market.ev_to_nopat_ttm, 10);
  assert.equal(facts.market.ev_to_nopat_next, 9.5);
  assert.equal(facts.market.fcf_yield, 0.08);
  assert.equal(facts.market.fcf_ex_sbc_yield, 0.07);
  const withheld = buildReportFacts([{ artifact_type: "valuation_scenario_set", content_json: { valuation_status: "withheld",
    terminal_anchor_bear: 0, terminal_anchor_base: 0, terminal_anchor_bull: 0, withheld_reason: "No price" } }])!;
  assert.equal(withheld.valuation_status, "withheld");
  assert.equal(withheld.cases.rows.length, 0);
});

test("the statement summary lists captured filings, uncaptured window quarters and missing balance-sheet lines", () => {
  const fact = (concept: string) => ({ concept, value: 1, text: "1", unit: "USD", start: null, end: "2026-06-30", dimensions: "", locator: "", scale: 0, fiscal_year: 2026, fiscal_quarter: 2, periodicity: "instant" as const });
  const table = (statement: any, fiscal_quarter: number, rows: { label: string; concept: string }[] = []) => ({ statement, identified_by: "heading" as const, title: "", source_document_id: "d", source_url: "",
    accession: "", filed: "2026-07-30", form: "10-Q", period_end: `2026-0${fiscal_quarter * 3}-30`, fiscal_year: 2026, fiscal_quarter, table_index: 0, warnings: [],
    rows: rows.map((r) => ({ cells: [{ text: r.label, colspan: 1, rowspan: 1, facts: [] }, { text: "1", colspan: 1, rowspan: 1, facts: [fact(r.concept)] }] })) });
  const summary = buildStatementSummary({
    tables: [table("income", 1), table("balance", 2, [{ label: "Long-term debt", concept: "us-gaap:LongTermDebtNoncurrent" }, { label: "Finance lease liabilities", concept: "us-gaap:FinanceLeaseLiabilityNoncurrent" }])],
    coverage: [{ form: "10-Q", period_end: "2026-06-30", status: "extracted", table_count: 3, missing: [], unresolved_facts: 0 }],
    reconciliation: [{ status: "passed" }, { status: "mismatch", period_end: "2026-06-30", check: "assets = liabilities + equity", difference: 5, unit: "USD" }],
    observations: [1, 2, 3],
  }, ["2025Q4", "2026Q1", "2026Q2"]);
  assert.deepEqual(summary.window_quarters_without_filing, ["2025Q4"]);
  assert.deepEqual(summary.reconciliation, { checks: 2, passed: 1, mismatches: ["2026-06-30: assets = liabilities + equity differs by 5 USD"] });
  assert.deepEqual(summary.latest_balance_sheet, { period_end: "2026-06-30", form: "10-Q", lines: ["Long-term debt", "Finance lease liabilities"],
    current_debt_line: false, finance_lease_liability_line: true });
});
