// Shared fixtures for the report-templates acceptance tests (Implementations/report-templates/implementation.md).
// Shapes follow the stored artifacts: financial_analytics (src/lib/research/history/analytics.ts), operating and
// valuation scenario sets (src/lib/research/valuation/v2.ts, tests/report-charts.test.ts).
import type { ReportArtifact, ReportEvidence } from "../../../src/lib/research/reporting/report";

export const EVIDENCE_ID = "6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
export const EVIDENCE_ID_2 = "7a2d3b21-4c5e-4f60-9bac-1d2e3f405162";
export const ANALYTICS_ID = "11111111-2222-4333-8444-555555555555";
export const OPS_ID = "21111111-2222-4333-8444-555555555555";
export const VAL_ID = "31111111-2222-4333-8444-555555555555";
export const RUN_ID = "41111111-2222-4333-8444-555555555555";

const quarters = ["2023Q1", "2023Q2", "2023Q3", "2023Q4", "2024Q1", "2024Q2", "2024Q3", "2024Q4", "2025Q1", "2025Q2"];

export const analytics = {
  artifact_type: "financial_analytics", currency: "USD",
  units: "Amounts in currency millions, shares in millions, ratios as decimals, days as days.",
  window: { start: "2023Q1", end: "2025Q2", quarters: 10 },
  tax_rate: { normalized: 0.15, quarters_used: 10, method: "Median quarterly effective tax rate" },
  statistics: { columns: ["metric", "n", "median", "min", "max", "latest", "latest_period", "percentile"], rows: [
    ["operating_margin", 10, 0.35, 0.3, 0.4, 0.38, "2025Q2", 0.8],
    ["fcf_ttm", 10, 40589, 30000, 50000, 48000, "2025Q2", 0.9],
    ["dso", 10, 45.2, 40, 50, 44, "2025Q2", 0.4],
  ] },
  quarterly: { columns: ["period", "revenue", "operating_income", "revenue_yoy", "gross_margin", "operating_margin", "fcf_margin", "capex_to_revenue", "sbc_to_revenue"],
    rows: quarters.map((period, i) => [period, 30000 + i * 1000, 10000 + i * 400, i < 4 ? null : 0.2 + i / 100, 0.8, 0.3 + i / 100, 0.25, 0.2, 0.08]) },
  segments: {
    members: { columns: ["segment", "role"], rows: [["Apps", "earner"], ["Labs", "burner"]] },
    quarterly: { columns: ["period", "segment", "revenue", "operating_income", "operating_margin"], rows: [["2025Q2", "Apps", 38000, 18000, 0.47], ["2025Q2", "Labs", 400, -4500, -11.25]] },
    annual: { columns: ["fiscal_year", "segment", "revenue", "operating_income", "operating_margin", "loss_to_earner_operating_income"],
      rows: [[2024, "Apps", 150000, 70000, 0.4667, null], [2024, "Labs", 1500, -17000, -11.33, 0.243]] },
  },
  cash_conversion: {
    quarterly: { columns: ["period", "fcf_ttm", "fcf_after_lease_principal_ttm", "fcf_to_net_income", "ocf_to_net_income", "capex_to_da", "growth_capex_ttm", "nopat_ttm", "invested_capital", "roic", "revenue_to_net_ppe", "net_income_ttm"],
      rows: quarters.map((period, i) => [period, 40000 + i * 500, 39000, 0.9, 1.4, 2.1, 20000, 45000, 150000, 0.3, 1.1, 46000]) },
    incremental: { columns: ["from", "to", "years", "change_in_revenue_ttm", "change_in_nopat_ttm", "change_in_invested_capital", "incremental_operating_margin", "incremental_roic"], rows: [] },
  },
  working_capital: { quarterly: { columns: ["period", "dso", "dpo", "dio", "ccc", "nwc_to_revenue", "payables_basis"], rows: [] }, notes: [] },
  capital_allocation: {
    quarterly: { columns: ["period", "cash", "marketable_securities", "long_term_debt", "net_cash", "shares", "shares_yoy", "buybacks_ttm", "dividends_ttm", "sbc_ttm", "buybacks_to_fcf", "dividends_to_fcf", "sbc_to_fcf", "market_cap", "buyback_yield", "dividend_yield", "fcf_yield", "fcf_ex_sbc_yield"],
      rows: quarters.map((period, i) => [period, 40000, 30000, 28000, 42000, 2500 - i, -0.01, 30000, 5000, 15000, 0.7, 0.12, 0.35, 1500000, 0.02, 0.003, 0.03, 0.02]) },
    share_classes: { columns: ["class", "period", "shares", "shares_year_ago"], rows: [] }, notes: [],
  },
  definitions: {}, derived_quarters: [], missing: [],
};

const method = (scenario_type: string, cash: number) => ({ method: "fcff", method_name: "Driver-based FCFF DCF", scenario_type, rationale: "r", currency: "USD",
  cash_flow_label: "FCFF", discount_rate: 0.1, years: [{ fiscal_year: 2026, cash_flow: cash }, { fiscal_year: 2027, cash_flow: cash }],
  terminal: { type: "multiple", metric: "nopat", metric_value: 100, multiple: 10 }, equity_bridge: -50, equity_bridge_explanation: "Cash less debt.", diluted_shares: 10, source_notes: ["n"] });
const scenario = (scenario_type: string, growth: number, margin: number) => ({ scenario_type, yearly_drivers: [
  { fiscal_year: 2026, revenue_growth: growth, operating_margin: margin }, { fiscal_year: 2027, revenue_growth: growth, operating_margin: margin + 0.02 }] });

export const operatingScenarios = { scenarios: [scenario("bear", 0.02, 0.28), scenario("base", 0.08, 0.32), scenario("bull", 0.12, 0.36)] };

export const valuation = {
  terminal_year: 2027, terminal_anchor_bear: 80, terminal_anchor_base: 100, terminal_anchor_bull: 130, current_market_price: 95, currency: "USD",
  method_inputs: [method("bear", 50), method("base", 60), method("bull", 70)],
  valuation_matrix: { columns: ["case", "valuation_set", "discount_rate", "terminal_growth", "ronic", "value_per_share", "return_to_value"],
    rows: [["base", "base", 0.09, 0.025, 0.2, 105.2, 0.107], ["bear", "conservative", 0.1, 0.02, 0.15, 61.4, -0.354]], note: "Value per share today." },
  sensitivity_grid: { columns: ["discount_rate", "terminal_growth", "value_per_share"], rows: [[0.08, 0.02, 120.5], [0.08, 0.03, 131], [0.1, 0.02, 98.25], [0.1, 0.03, null]], case: "base", note: "Base case." },
  stress_cases: [{ case: "impairment", value_per_share: 55.1, return: -0.42, definition: "Bear operations, conservative set and RONIC = r." },
    { case: "tail", value_per_share: 31.2, return: -0.67, definition: "Also g = 0 and final NOPAT cut 30%." }],
};

export const artifact = (id: string, artifact_type: string, content_json: Record<string, any>): ReportArtifact =>
  ({ id, artifact_type, scope_key: `${artifact_type}-scope`, artifact_version: 1, content_json });

export const artifacts: ReportArtifact[] = [
  artifact(ANALYTICS_ID, "financial_analytics", analytics),
  artifact(OPS_ID, "operating_scenario_set", operatingScenarios),
  artifact(VAL_ID, "valuation_scenario_set", valuation),
];

export const evidence: ReportEvidence[] = [
  { id: EVIDENCE_ID, claim_text: "Revenue rose 22% in Q2 2025.", source_title: "Q2 2025 earnings release", url: "https://example.com/q2",
    published_at: "2025-07-30T00:00:00.000Z", location: "Page 1", quote: "Revenue was $39.1 billion, an increase of 22% year-over-year." },
  { id: EVIDENCE_ID_2, claim_text: "Capex guidance was raised.", source_title: "Q2 2025 10-Q", url: "https://example.com/10q",
    published_at: "2025-07-31T00:00:00.000Z", location: "MD&A", quote: "We now expect capital expenditures of $66-72 billion." },
];

/** A body section as stored after code places exhibits (standard adaptive-3). */
export const bodySection = (id: string, coverage: string[], exhibits: string[] = []) => ({
  id, title: `${id} chapter`, purpose: "Explain the driver.", coverage, artifact_ids: [ANALYTICS_ID],
  paragraphs: [{ kind: "fact" as const, text: "Revenue rose 22% year on year in Q2 2025.", evidence_ids: [EVIDENCE_ID], artifact_ids: [] }],
  counterevidence: "Growth may slow as comparisons harden.", implication: "Margins carry the thesis.", gaps: [], tables: [], exhibits,
});
