// Independent checks: a smaller company with perpetuity terminal values, negative net cash,
// working-capital drag, missing tax history, and boundary inputs.
import test from "node:test";
import assert from "node:assert/strict";
import { calculateValuationSchedule } from "../../../src/lib/research/valuation/schedules";
import { validateArtifactContent } from "../../../src/lib/research/stage-contracts";
import { valuationFinancialInputs } from "../../../src/lib/research/valuation/financial-inputs";

async function engine() {
  const modulePath = "../../../src/lib/research/valuation/engine";   // variable: not resolved by tsc before implementation
  const mod: Record<string, any> = await import(modulePath).catch(() => ({}));
  for (const name of ["latestRiskFreeRate", "historyRatios", "equityBridge", "buildScenarioStatements", "buildFcffSchedule", "valuationPricePath", "assembleValuation", "impliedOperatingMargin", "valuationReadiness", "validateScenarioDriverCoverage", "valuationAssumptionsFormat"]) {
    assert.ok(name in mod, `engine export ${name} is missing`);
  }
  return mod;
}
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const ratios = { da_to_revenue: 0.05, capex_to_revenue: 0.06, tax_rate: 0.25 };
const drivers = [
  { fiscal_year: 2027, revenue_growth: -0.10, operating_margin: 0.08, nwc_to_revenue_change: 0.2 },
  { fiscal_year: 2028, revenue_growth: 0.05, operating_margin: 0.10, nwc_to_revenue_change: 0.2, tax_rate: 0.3, da_to_revenue: 0.04 },
];
const input = { baseRevenue: 1_000, baseYear: 2026, ratios, drivers };
const perpetuity = { scenario_type: "base", discount_rate: 0.11, terminal: { type: "perpetuity", growth_rate: 0.02 }, rationale: "11% cost of capital, 2% long-run growth." };
const row = (metric_key: string, period_end: string, value: number, periodicity = "annual") => ({
  metric_key, period_end, value_numeric: value, periodicity, fiscal_year: Number(period_end.slice(0, 4)),
  fiscal_quarter: periodicity === "annual" ? null : Math.ceil(Number(period_end.slice(5, 7)) / 3),
  unit: "USD", currency: "USD", segment: null, geography: null, available_at: period_end, restatement_version: 0, metadata_json: {},
});

test("AC-1: blank and '.' FRED values are skipped; a cutoff after the last row uses the last value", async () => {
  const { latestRiskFreeRate } = await engine();
  const csv = "observation_date,DGS10\n2026-01-02,4.10\n2026-01-05,.\n2026-01-06,\n";
  assert.deepEqual(latestRiskFreeRate(csv, "2026-03-01"), { rate: 0.041, observation_date: "2026-01-02" });
  assert.equal(latestRiskFreeRate("observation_date,DGS10\n", "2026-03-01"), null);
});

test("AC-2: readiness reports a missing price, base revenue and a missing scenario together", async () => {
  const { valuationReadiness } = await engine();
  const r = valuationReadiness({ drivers: { base: drivers, bull: drivers }, horizon: [2027, 2028], dilutedSharesMillions: 40, marketPrice: 0, baseRevenue: null });
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m: string) => /bear/.test(m)), r.missing.join("; "));
  assert.ok(r.missing.some((m: string) => /price/i.test(m)), r.missing.join("; "));
  assert.ok(r.missing.some((m: string) => /revenue/i.test(m)), r.missing.join("; "));
});

test("AC-3: without tax lines the statutory default is used and labelled; only the last three years count", async () => {
  const { historyRatios } = await engine();
  const m = 1e6;
  const fi = valuationFinancialInputs({
    statementObservations: [
      row("revenue", "2022-12-31", 100 * m), row("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", "2022-12-31", 90 * m),
      ...["2023", "2024", "2025"].flatMap((y) => [row("revenue", `${y}-12-31`, 1_000 * m), row("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", `${y}-12-31`, 60 * m), row("us_gaap_DepreciationDepletionAndAmortization", `${y}-12-31`, 50 * m)]),
    ],
    cutoff: new Date("2026-06-30"),
  });
  const r = historyRatios(fi);
  near(r.capex_to_revenue, 0.06);
  near(r.da_to_revenue, 0.05);
  assert.equal(r.tax_rate, 0.21);
  assert.equal(r.tax_rate_source, "statutory_default");
});

test("AC-4: shrinking revenue, working-capital release and per-year overrides", async () => {
  const { buildScenarioStatements } = await engine();
  const [a, b] = buildScenarioStatements(input);
  near(a.revenue, 900); near(a.operating_income, 72); near(a.nopat, 54);
  // Field name per the plan's StatementYear (matches build.change_in_net_working_capital in schedules.ts).
  near(a.change_in_net_working_capital, -20, 1e-9);   // 0.2 * (900 - 1000): revenue fell, working capital is released
  near(a.fcff, 54 + 45 - 54 + 20);            // NOPAT + D&A(5%) - capex(6%) - ΔNWC
  near(b.revenue, 945); near(b.nopat, 94.5 * 0.7); near(b.depreciation_amortization, 37.8);
  near(b.fcff, 66.15 + 37.8 - 56.7 - 9);
});

test("AC-5/AC-6: perpetuity terminal value and a net-debt bridge flow through the path", async () => {
  const { buildScenarioStatements, buildFcffSchedule, valuationPricePath } = await engine();
  const statements = buildScenarioStatements(input);
  const s = buildFcffSchedule({ statements, assumptions: perpetuity, bridge: -300, dilutedSharesMillions: 40, currency: "USD", sourceNotes: ["v"] });
  assert.equal(s.terminal.type, "perpetuity");
  const path = valuationPricePath(s);
  const tv = statements[1].fcff * 1.02 / (0.11 - 0.02);
  // Valuation v2: each year-end value also carries the FCFF retained to then.
  near(path[1].price_target, (tv - 300 + statements[0].fcff + statements[1].fcff) / 40);
  near(path[0].price_target, ((tv + statements[1].fcff) / 1.11 - 300 + statements[0].fcff) / 40);
  near(((((tv + statements[1].fcff) / 1.11) + statements[0].fcff) / 1.11 - 300) / 40, calculateValuationSchedule(s).value_per_share, 1e-9);
});

test("AC-7/AC-11: model-built FCFE schedules (banks) are assembled by code; weights that don't sum to 1 give no weighted target", async () => {
  const { assembleValuation } = await engine();
  const fcfe = (scenario_type: string, cf: number) => ({
    method: "fcfe", method_name: `FCFE ${scenario_type}`, scenario_type, rationale: "Bank: equity cash flows.", currency: "USD",
    cash_flow_label: "FCFE", discount_rate: 0.12,
    years: [2026, 2027, 2028, 2029, 2030].map((fiscal_year, i) => ({ fiscal_year, cash_flow: cf * (1 + i * 0.1) })),
    terminal: { type: "perpetuity", growth_rate: 0.03 }, equity_bridge: 0, equity_bridge_explanation: "Equity method: no bridge.",
    diluted_shares: 1_100, source_notes: ["model-built schedule"],
  });
  const out = assembleValuation({ schedules: { bear: fcfe("bear", 300), base: fcfe("base", 500), bull: fcfe("bull", 700) }, probabilities: { probability_bear: 0.3, probability_base: 0.3, probability_bull: 0.3 }, marketPrice: 21.5, currency: "USD" });
  assert.equal(out.valuation_scenario_set.terminal_year, 2030);
  assert.ok(out.valuation_scenario_set.terminal_anchor_bear < out.valuation_scenario_set.terminal_anchor_base);
  assert.equal(out.valuation_scenario_set.weighted_target ?? null, null);
  assert.equal(out.annual_price_target_path.price_target_path.length, 15);
  for (const [type, content] of Object.entries(out)) assert.equal(validateArtifactContent(type, content).valid, true, type);
});

test("AC-8: no implied margin is reported when no margin in range reaches the price", async () => {
  const { impliedOperatingMargin } = await engine();
  const value = impliedOperatingMargin({ ...input, assumptions: perpetuity, bridge: -300, dilutedSharesMillions: 40, marketPrice: 1e9 });
  assert.equal(value, null);
});

test("AC-9: discount rate equal to risk-free, growth at the discount rate, and two scenarios are all rejected", async () => {
  const { valuationAssumptionsFormat } = await engine();
  const scenarios = ["bear", "base", "bull"].map((scenario_type) => ({ ...perpetuity, scenario_type }));
  const body = (list: any[]) => ({ valuation_assumptions: { artifact_type: "valuation_assumptions", scenarios: list, omitted_methods: [], source_notes: ["n"] } });
  assert.ok(valuationAssumptionsFormat(0.11).validate(body(scenarios)).length > 0, "equal to the risk-free rate is not above it");
  assert.ok(valuationAssumptionsFormat(0.04).validate(body(scenarios.map((s) => ({ ...s, terminal: { type: "perpetuity", growth_rate: 0.11 } })))).length > 0);
  assert.ok(valuationAssumptionsFormat(0.04).validate(body(scenarios.slice(0, 2))).length > 0);
  assert.deepEqual(valuationAssumptionsFormat(null).validate(body(scenarios)), [], "no risk-free rate: only the other rules apply");
});

test("AC-10: a scenario missing entirely is reported; extra years beyond the horizon are fine", async () => {
  const { validateScenarioDriverCoverage } = await engine();
  const extra = [...drivers, { fiscal_year: 2029, revenue_growth: 0.03, operating_margin: 0.1 }];
  const problems = validateScenarioDriverCoverage({ scenarios: [{ scenario_type: "base", yearly_drivers: extra }, { scenario_type: "bull", yearly_drivers: drivers }] }, [2027, 2028]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bear/);
});

test("AC-3: the equity bridge uses the latest balance row and names missing components", async () => {
  const { equityBridge } = await engine();
  const m = 1e6;
  const q = (k: string, v: number) => row(k, "2026-06-30", v * m, "quarterly");
  const fi = valuationFinancialInputs({
    statementObservations: [
      row("revenue", "2025-12-31", 1_000 * m), row("us_gaap_CashAndCashEquivalentsAtCarryingValue", "2025-12-31", 999 * m),
      q("revenue", 250), q("us_gaap_CashAndCashEquivalentsAtCarryingValue", 120), q("us_gaap_LongTermDebtNoncurrent", 400),
      q("us_gaap_OperatingLeaseLiabilityCurrent", 5), q("us_gaap_OperatingLeaseLiabilityNoncurrent", 15),
    ],
    cutoff: new Date("2026-10-10"),
  });
  const bridge = equityBridge(fi);
  assert.equal(bridge.period_end, "2026-06-30");
  // Valuation v2: operating lease liabilities are not subtracted (their cost is in operating income).
  near(bridge.amount, 120 - 400);
  assert.deepEqual(bridge.excluded, { operating_lease_liabilities: 20 });
  assert.ok(bridge.missing.includes("marketable_securities"));
});
