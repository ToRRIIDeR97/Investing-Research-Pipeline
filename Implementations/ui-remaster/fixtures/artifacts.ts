// SoFi's real run values (run 0c9a2731, 2026-11-18), trimmed to the fields the snapshot reads.
const columns = ["case", "probability", "method", "discount_rate", "terminal", "pv_per_share", "return_to_pv", "terminal_year", "terminal_price_target"];
export const reportFacts = (overrides: Record<string, unknown> = {}) => ({ type: "report_facts", content_json: {
  artifact_type: "report_facts", currency: "USD", market_price: 14.28, valuation_status: "complete",
  weighted: { pv_per_share: 1.38, return_to_pv: -0.9036 },
  cases: { columns, rows: [
    ["bear", 0.3, "fcfe", 0.1309, "7x", -1.79, -1.1256, 2030, 2.35],
    ["base", 0.5, "fcfe", 0.1309, "9x", 1.13, -0.9208, 2030, 9.36],
    ["bull", 0.2, "fcfe", 0.1309, "11x", 6.74, -0.5277, 2030, 20.5],
  ] },
  ...overrides,
} });
export const valuationSet = (verified: boolean) => ({ type: "valuation_scenario_set", content_json: {
  current_market_price: 14.28, current_market_price_source: { verified }, value_today_bear: -1.8, value_today_base: 1.1, value_today_bull: 6.7,
} });
export const pricePath = { type: "annual_price_target_path", content_json: { currency: "USD", price_target_path: [
  { fiscal_year: 2027, scenario_type: "base", price_target: 0.76 }, { fiscal_year: 2026, scenario_type: "base", price_target: 0.15 },
  { fiscal_year: 2026, scenario_type: "bear", price_target: -2.1 }, { fiscal_year: 2026, scenario_type: "bull", price_target: 3.34 },
  { fiscal_year: 2027, scenario_type: "bull", price_target: 4.9 }, { fiscal_year: 2027, scenario_type: "bear", price_target: -1.5 },
] } };
export const monitoring = { type: "monitoring_dashboard", content_json: { items: [
  { kpi: "Capital headroom", unit: "percent", current_level: 16.9, bear_threshold: 10, bull_threshold: 16.9, base_range: "14.5% to 17%" },
  { kpi: "Share count and dilution", unit: "shares", current_level: 1296617325, bear_threshold: 1400000000, bull_threshold: 1300000000 },
  { kpi: "Card net charge-offs", unit: "percent", current_level: 6.68, bear_threshold: 6.5, bull_threshold: 5 },
  { kpi: "Net charge-off ratio", unit: "percent", current_level: 1.62, bear_threshold: 2.5, bull_threshold: 1.2 },
  { kpi: "Text only", unit: "percent", current_level: "rising" },
] } };
