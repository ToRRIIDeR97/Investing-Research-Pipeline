// Fixtures for the deterministic valuation engine acceptance tests. Amounts in USD millions.
import assert from "node:assert/strict";

export const ENGINE_EXPORTS = [
  "latestRiskFreeRate", "historyRatios", "equityBridge", "buildScenarioStatements", "buildFcffSchedule",
  "valuationPricePath", "assembleValuation", "impliedOperatingMargin", "impliedRevenueGrowth",
  "valuationReadiness", "validateScenarioDriverCoverage", "valuationAssumptionsFormat",
] as const;

export async function loadEngine() {
  let mod: Record<string, any> = {};
  // A variable specifier keeps tsc from resolving a module that exists only after implementation.
  const modulePath = "../../../src/lib/research/valuation/engine";
  try { mod = await import(modulePath); } catch { mod = {}; }
  for (const name of ENGINE_EXPORTS) {
    assert.ok(name in mod, `src/lib/research/valuation/engine.ts must export ${name}`);
  }
  return mod as Record<(typeof ENGINE_EXPORTS)[number], any>;
}

export const FRED_CSV = [
  "observation_date,DGS10",
  "2026-10-05,5.31",
  "2026-10-06,",
  "2026-10-07,5.28",
  "2026-10-08,5.22",
  "2026-10-09,5.25",
].join("\n");

/** Base year FY2025: revenue 200,000; D&A 9%; capex 35%; tax 18% of pretax. */
export const RATIOS = { da_to_revenue: 0.09, capex_to_revenue: 0.35, tax_rate: 0.18 };

export const BASE_DRIVERS = [
  { fiscal_year: 2026, revenue_growth: 0.20, operating_margin: 0.38, capex_to_revenue: 0.45 },
  { fiscal_year: 2027, revenue_growth: 0.12, operating_margin: 0.36 },
  { fiscal_year: 2028, revenue_growth: 0.10, operating_margin: 0.37 },
];

export const statementInput = (drivers = BASE_DRIVERS) => ({ baseRevenue: 200_000, baseYear: 2025, ratios: RATIOS, drivers });

export const BASE_ASSUMPTIONS = {
  scenario_type: "base", discount_rate: 0.09,
  terminal: { type: "multiple", metric: "nopat", multiple: 20 },
  rationale: "9% cost of equity: 5.22% 10-year Treasury plus a 3.8% premium; 20x NOPAT exit.",
};

export const BRIDGE = 25_000;   // cash 50,000 + securities 20,000 - debt 30,000 - leases 15,000
export const SHARES = 2_500;

export const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${a} is not within ${tolerance} of ${b}`);

/** Observation rows in the shape valuationFinancialInputs reads (see tests/valuation-inputs.test.ts). */
export const obs = (metric_key: string, period_end: string, value: number, extra: Record<string, unknown> = {}) => ({
  metric_key, period_end, value_numeric: value, periodicity: "annual", fiscal_year: Number(period_end.slice(0, 4)),
  fiscal_quarter: null, unit: "USD", currency: "USD", reporting_basis: "gaap", segment: null, geography: null,
  available_at: "2026-02-01", restatement_version: 0, metadata_json: {}, ...extra,
});
