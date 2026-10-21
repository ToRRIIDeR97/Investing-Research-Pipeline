import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleValuation, buildFcffSchedule, buildScenarioStatements, equityBridge, forecastHorizon, historyRatios,
  impliedOperatingMargin, latestRiskFreeRate, valuationAssumptionsFormat,
} from "../src/lib/research/valuation/engine";
import { valuationFinancialInputs } from "../src/lib/research/valuation/financial-inputs";
import { validateAnnualPriceTargetPath } from "../src/lib/research/valuation/validation";
import { validateArtifactContent } from "../src/lib/research/stage-contracts";

const obs = (metric_key: string, period_end: string, value: number, periodicity = "annual") => ({
  metric_key, period_end, value_numeric: value, periodicity, fiscal_year: Number(period_end.slice(0, 4)),
  fiscal_quarter: periodicity === "annual" ? null : 2, currency: "USD", segment: null, available_at: "2026-08-01", restatement_version: 0, metadata_json: {},
});

test("FRED rows marked '.' are skipped and a full ISO cutoff is accepted", () => {
  assert.deepEqual(latestRiskFreeRate("observation_date,DGS10\r\n2026-10-07,4.1\r\n2026-10-08,.\r\n", "2026-10-08T12:00:00Z"), { rate: 0.041, observation_date: "2026-10-07" });
  assert.equal(latestRiskFreeRate("observation_date,DGS10\n", "2026-10-08"), null);
});

test("the equity bridge uses the latest balance row and names missing items; tax falls back to 21%", () => {
  const m = 1e6;
  const fi = valuationFinancialInputs({ statementObservations: [
    obs("revenue", "2025-12-31", 100 * m), obs("us_gaap_CashAndCashEquivalentsAtCarryingValue", "2025-12-31", 10 * m),
    obs("us_gaap_CashAndCashEquivalentsAtCarryingValue", "2026-06-30", 50 * m, "quarterly"),
    obs("us_gaap_LongTermDebtNoncurrent", "2026-06-30", 30 * m, "quarterly"),
    obs("us_gaap_OperatingLeaseLiability", "2026-06-30", 15 * m, "quarterly"),
    obs("us_gaap_MarketableSecuritiesCurrent", "2025-12-31", 4 * m),
    obs("meta_NonmarketableEquitySecuritiesCarryingValue", "2026-06-30", 6 * m, "quarterly"),
  ], cutoff: new Date("2026-10-10") });
  const bridge = equityBridge(fi)!;
  // Cash 50 + securities 4 (carried from FY2025) + investments 6 - debt 30; operating leases are not subtracted.
  assert.equal(bridge.amount, 30);
  assert.equal(bridge.period_end, "2026-06-30");
  assert.deepEqual(bridge.carried_forward, { marketable_securities: "2025-12-31" });
  assert.deepEqual(bridge.excluded, { operating_lease_liabilities: 15 });
  assert.deepEqual(bridge.missing, ["current_debt", "finance_lease_liabilities", "noncontrolling_interest"]);
  const ratios = historyRatios(fi);
  assert.deepEqual([ratios.tax_rate, ratios.tax_rate_source, ratios.da_to_revenue], [0.21, "statutory_default", null]);
  assert.equal(equityBridge(null), null);
  assert.deepEqual(forecastHorizon(2025, 3), [2026, 2027, 2028]);
});

test("bank FCFE schedules are assembled by code: anchors are the terminal-year values", () => {
  const fcfe = (scenario_type: string, cash: number) => ({
    method: "fcfe", method_name: "FCFE", scenario_type, rationale: "Fixture", currency: "USD", cash_flow_label: "FCFE", discount_rate: 0.1,
    years: [2026, 2027].map((fiscal_year) => ({ fiscal_year, cash_flow: cash })), terminal: { type: "perpetuity", growth_rate: 0.02 },
    equity_bridge: 0, equity_bridge_explanation: "Equity cash flow", diluted_shares: 100, source_notes: ["Fixture"],
  }) as any;
  const out = assembleValuation({ schedules: { bear: fcfe("bear", 50), base: fcfe("base", 100), bull: fcfe("bull", 150) },
    probabilities: { probability_bear: 0.2, probability_base: 0.5, probability_bull: 0.2 }, marketPrice: 10, currency: "USD" });
  assert.equal(out.valuation_scenario_set.terminal_anchor_base, (100 * 1.02 / 0.08) / 100);
  assert.equal("weighted_target" in out.valuation_scenario_set, false, "weights that do not sum to 1 give no weighted target");
  assert.deepEqual(validateAnnualPriceTargetPath(out.annual_price_target_path, out.valuation_scenario_set).errors, []);
  for (const [type, content] of Object.entries(out)) assert.equal(validateArtifactContent(type, content).valid, true, type);
  assert.throws(() => assembleValuation({ schedules: { bear: fcfe("bear", 50), base: fcfe("base", 100), bull: { ...fcfe("bull", 1), years: [{ fiscal_year: 2026, cash_flow: 1 }] } },
    probabilities: {}, marketPrice: 10, currency: "USD" }), /bull schedule covers FY2026/);
});

test("an unreachable market price gives no implied margin, and the format rejects duplicate scenarios", () => {
  const drivers = [2026, 2027].map((fiscal_year) => ({ fiscal_year, revenue_growth: 0.1, operating_margin: 0.2 }));
  const input = { baseRevenue: 100, baseYear: 2025, ratios: { da_to_revenue: 0.05, capex_to_revenue: 0.05, tax_rate: 0.2 }, drivers,
    assumptions: { scenario_type: "base" as const, discount_rate: 0.1, terminal: { type: "multiple" as const, metric: "nopat" as const, multiple: 10 }, rationale: "x" },
    bridge: 0, dilutedSharesMillions: 1 };
  assert.equal(impliedOperatingMargin({ ...input, marketPrice: 1e9 }), null);
  const statements = buildScenarioStatements(input);
  const price = buildFcffSchedule({ statements, assumptions: input.assumptions, bridge: 0, dilutedSharesMillions: 1, currency: "USD", sourceNotes: [] });
  assert.equal(price.years.length, 2);
  const scenario = { scenario_type: "base", discount_rate: 0.09, terminal: { type: "perpetuity", growth_rate: 0.02 }, rationale: "x" };
  const errors = valuationAssumptionsFormat(null).validate!({ valuation_assumptions: { artifact_type: "valuation_assumptions", scenarios: [scenario, scenario, { ...scenario, scenario_type: "bull" }] } });
  assert.match(errors.map((e) => e.message).join(" "), /exactly one bear/);
});
