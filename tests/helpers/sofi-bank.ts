/**
 * SoFi inputs from paid run 7c70364e-21b6-4cc4-8659-187024f4d405 (cutoff 2026-11-25): the operating scenarios' yearly
 * drivers and numeric assumptions (average loan growth, SoFi Bank CET1), the base case's operating-model first year,
 * the SEC companyfacts extract, the 14.9% SoFi Bank CET1 metric, the 1,357.811m reported diluted shares, the 12.86
 * close on 2026-11-24, the 0.1267 CAPM cost of equity and the 0.0492 risk-free rate.
 */
import { readFileSync } from "node:fs";
import { buildScenarioStatements, type Scenario } from "../../src/lib/research/valuation/engine";
import { bankCapitalBase, currentCet1Ratio, defaultBankAssumptions, type ScenarioInput } from "../../src/lib/research/valuation/bank";

const years = [2026, 2027, 2028, 2029, 2030];
const tax = [0.09, 0.14, 0.18, 0.21, 0.24];
const cases: Record<Scenario, { growth: number[]; margin: number[]; loans: number[]; cet1: number[] }> = {
  bear: { growth: [0.3849, 0.12, 0.09, 0.07, 0.06], margin: [0.18, 0.1685, 0.1533, 0.1541, 0.157], loans: [0.38, 0.1, 0.08, 0.06, 0.05], cet1: [0.13, 0.115, 0.115, 0.115, 0.115] },
  base: { growth: [0.4264, 0.25, 0.2, 0.17, 0.14], margin: [0.20405, 0.2191, 0.232, 0.2547, 0.277], loans: [0.4, 0.2, 0.15, 0.12, 0.1], cet1: [0.14, 0.13, 0.125, 0.125, 0.125] },
  bull: { growth: [0.4508, 0.32, 0.25, 0.2, 0.17], margin: [0.215, 0.2407, 0.2966, 0.331, 0.3633], loans: [0.42, 0.28, 0.22, 0.18, 0.14], cet1: [0.14, 0.145, 0.14, 0.14, 0.14] },
};
const SCENARIOS = ["bear", "base", "bull"] as const;

export const SOFI = {
  price: 12.86, valuationDate: "2026-11-24", shares: 1357.811, capm: 0.1267, riskFree: 0.0492, fiscalYearEnd: "12-31",
  probabilities: { probability_bear: 0.3, probability_base: 0.5, probability_bull: 0.2 },
  netIncomeTtm: 805.7,
};

export function sofiInputs() {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/sofi-bank-facts.json", import.meta.url), "utf8"));
  const base = bankCapitalBase({ companyFacts: fixture.companyFacts, currency: "USD", cutoff: new Date("2026-11-25T14:37:07Z"), firstForecastYearStart: "2026-01-01" })!;
  const statements = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, buildScenarioStatements({
    baseRevenue: 3613.4, baseYear: 2025, ratios: { da_to_revenue: 0.06, capex_to_revenue: 0.06, tax_rate: 0.21 },
    firstYear: scenario === "base" ? { revenue: 5154.2, operating_income: 1051.7 } : null,
    drivers: years.map((fiscal_year, i) => ({ fiscal_year, revenue_growth: cases[scenario].growth[i], operating_margin: cases[scenario].margin[i], tax_rate: tax[i] })),
  })])) as Record<Scenario, ReturnType<typeof buildScenarioStatements>>;
  const scenarios: ScenarioInput[] = SCENARIOS.map((scenario_type) => ({ scenario_type, numeric_assumptions: years.flatMap((fiscal_year, i) => [
    { driver_key: "average_loan_growth", fiscal_year, value: cases[scenario_type].loans[i] },
    { driver_key: "sofi_bank_cet1_ratio", fiscal_year, value: cases[scenario_type].cet1[i] },
  ]) }));
  const current = currentCet1Ratio({ base, targetKeys: ["sofi_bank_cet1_ratio"], metrics: [
    { metric_key: "cet1_capital", value_numeric: "9520479", period_end: "2026-09-30" },
    { metric_key: "sofi_bank_cet1_ratio", value_numeric: "0.149", period_end: "2026-09-30" },
  ] });
  const defaults = defaultBankAssumptions({ scenarios, statements, base, current, capm: SOFI.capm, riskFree: SOFI.riskFree,
    valuationDate: SOFI.valuationDate, fiscalYearEnd: SOFI.fiscalYearEnd, shares: SOFI.shares });
  return { base, statements, scenarios, current, defaults };
}
