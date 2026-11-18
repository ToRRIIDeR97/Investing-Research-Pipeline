import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FinancialAnalytics, buildFinancialAnalytics, tableRows } from "../src/lib/research/history/analytics";
import { buildReportFacts } from "../src/lib/research/reporting/facts";
import { statementSeries } from "../src/lib/research/reporting/visuals";
import { BANK_FCFE_RULE, equityMethodsPrompt, fcfeRetentionErrors } from "../src/lib/research/handlers/asset-valuation";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/meta-statements.json", import.meta.url), "utf8"));
const observations = fixture.rows.map((row: unknown[]) => Object.fromEntries(fixture.columns.map((c: string, i: number) => [c, row[i]])))
  .map((r: Record<string, any>) => ({ ...r, currency: /^[A-Z]{3}$/.test(r.unit) ? r.unit : null,
    metadata_json: r.statement ? { statement: r.statement } : { metric_category: "market_data" } }));
const pack = FinancialAnalytics.parse(buildFinancialAnalytics({ observations, endFiscalYear: 2026, endFiscalQuarter: 2 }));

type Build = { starting_profit: number; change_in_net_working_capital: number };
const fcfe = (scenario_type: "bear" | "base" | "bull", builds: Build[]) => ({ method: "fcfe" as const, method_name: "FCFE", scenario_type, rationale: "r", currency: "USD",
  cash_flow_label: "FCFE", discount_rate: 0.12, equity_bridge: 0, equity_bridge_explanation: "equity method", diluted_shares: 10, source_notes: ["n"],
  terminal: { type: "multiple" as const, metric: "net_income", metric_value: builds.at(-1)!.starting_profit, multiple: 10 },
  years: builds.map((b, i) => ({ fiscal_year: 2027 + i, cash_flow: b.starting_profit - b.change_in_net_working_capital,
    build: { starting_profit: b.starting_profit, depreciation_amortization: 0, capital_expenditures: 0, change_in_net_working_capital: b.change_in_net_working_capital, other_adjustments: 0 } })) });

test("the analytics pack carries TTM net income", () => {
  const row = tableRows(pack.cash_conversion.quarterly).find((r) => r.period === "2026Q2")!;
  assert.equal(typeof row.net_income_ttm, "number");
  assert.ok(pack.definitions.net_income_ttm);
});

test("report_facts re-rates equity-method cases on P/E when there is no NOPAT, as for a bank", () => {
  const table = (columns: string[], rows: unknown[][]) => ({ columns, rows });
  const empty = table([], []);
  const bank = FinancialAnalytics.parse({ ...pack, statistics: empty, quarterly: empty, segments: { members: empty, quarterly: empty, annual: empty },
    cash_conversion: { quarterly: table(["period", "fcf_ttm", "nopat_ttm", "net_income_ttm"], [["2026Q3", null, null, 200]]), incremental: empty },
    capital_allocation: { quarterly: table(["period", "sbc_ttm"], [["2026Q3", 10]]), share_classes: empty, notes: [] } });
  const builds = [{ starting_profit: 100, change_in_net_working_capital: 20 }, { starting_profit: 110, change_in_net_working_capital: 20 }];
  const facts = buildReportFacts([
    { artifact_type: "financial_analytics", content_json: bank },
    { artifact_type: "valuation_scenario_set", content_json: { artifact_type: "valuation_scenario_set", terminal_year: 2028, current_market_price: 100,
      terminal_anchor_bear: 50, terminal_anchor_base: 60, terminal_anchor_bull: 70, probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25,
      method_inputs: (["bear", "base", "bull"] as const).map((t) => fcfe(t, builds)) } },
  ])!;
  // Market cap 100 × 10 = 1,000; P/E 1,000 ÷ 200 = 5; (5 × 110 + 0 + 80 + 90) ÷ 10 ÷ 100 − 1 = −0.28.
  assert.equal(facts.market.pe_ttm, 5);
  assert.equal(facts.market.earnings_yield, 0.2);
  assert.equal(facts.market.pe_next, 10);
  assert.equal(facts.market.ev_to_nopat_ttm, null);
  assert.equal(facts.market.ev_to_nopat_next, null, "net income is not reported as NOPAT");
  const base = tableRows(facts.cases as any).find((c) => c.case === "base")!;
  assert.equal(base.no_rerating_return, -0.28);
});

test("an FCFE schedule that reinvests more than net income every year is rejected with the bank rule", () => {
  const absorbed = fcfe("base", [{ starting_profit: 690, change_in_net_working_capital: 3206 }, { starting_profit: 636, change_in_net_working_capital: 1140 }]);
  const errors = fcfeRetentionErrors([absorbed]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /fcfe base: change_in_net_working_capital exceeds net income in every year/);
  assert.ok(errors[0].message.includes(BANK_FCFE_RULE));
  assert.deepEqual(fcfeRetentionErrors([fcfe("base", [{ starting_profit: 690, change_in_net_working_capital: 3206 }, { starting_profit: 900, change_in_net_working_capital: 120 }])]), [],
    "one year that pays owners is allowed");
  assert.deepEqual(fcfeRetentionErrors([{ ...absorbed, method: "fcff" as any }]), [], "only FCFE is checked");
  assert.match(equityMethodsPrompt({}), /deposit-funded lender/);
});

test("scenario statement lines are read by year or by metric", () => {
  const byYear = { years: { 2027: { revenue: 10 }, 2028: { revenue: 12 } } };
  const flat = { 2027: { revenue: 10 }, 2028: { revenue: 12 } };
  const byMetric = { revenue: { 2027: 10, 2028: 12 }, gaps: ["n"] };
  for (const shape of [byYear, flat, byMetric]) {
    assert.deepEqual(statementSeries(shape, "revenue").filter(([y, v]) => Number.isInteger(y) && typeof v === "number"), [[2027, 10], [2028, 12]]);
  }
  assert.deepEqual(statementSeries(undefined, "revenue"), []);
});
