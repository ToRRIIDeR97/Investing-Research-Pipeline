/**
 * Forecast contracts (Component 10) for Research OS v3.
 */

import { z } from "zod/v4";

export const ForecastDriver = z.object({
  driver_key: z.string().min(1),
  formula_decomposition: z.string().optional(), // if undefined, it violates CAGR rule if not decomposed
  historical_metric_key: z.string().min(1),
  historical_diagnosis_key: z.string().min(1),
  process_node_key: z.string().min(1),
  assumption_key: z.string().min(1),
  time_lag: z.string().min(1),
  failure_condition: z.string().min(1),
  financial_line_affected: z.string().min(1),
});
export type ForecastDriver = z.infer<typeof ForecastDriver>;

export const DriverTree = z.object({
  artifact_type: z.literal("driver_tree"),
  drivers: z.array(ForecastDriver).min(1),
});
export type DriverTree = z.infer<typeof DriverTree>;

export const NumericAssumption=z.object({driver_key:z.string().min(1),fiscal_year:z.number().int(),value:z.number(),unit:z.string().min(1),rationale:z.string().min(1),source_ids:z.array(z.string())});

/** One forecast year's drivers as decimals. Code builds the statements from them; overrides replace the history ratios. */
export const YearlyDriver = z.object({
  fiscal_year: z.number().int(),
  revenue_growth: z.number().gt(-1),
  operating_margin: z.number().lt(1),
  capex_to_revenue: z.number().min(0).nullable().optional(),
  da_to_revenue: z.number().min(0).nullable().optional(),
  tax_rate: z.number().min(0).lt(1).nullable().optional(),
  nwc_to_revenue_change: z.number().nullable().optional(),
});

export const OperatingScenarioEntry = z.object({
  numeric_assumptions:z.array(NumericAssumption).optional(),
  yearly_drivers: z.array(YearlyDriver).optional(),
  scenario_type: z.enum(["bear", "base", "bull"]),
  end_market: z.string().min(1),
  customer_economics: z.string().min(1),
  customer_spending: z.string().min(1),
  competitive_response: z.string().min(1),
  capacity: z.string().min(1),
  pricing_mix: z.string().min(1),
  moat_state: z.string().min(1),
  margin_formation: z.string().min(1),
  reinvestment: z.string().min(1),
  working_capital: z.string().min(1),
  balance_sheet: z.string().min(1),
  resulting_financial_statements_json: z.record(z.string(), z.unknown()),
  maintenance_spend: z.number().optional(), // For coherence checks
  revenue_cagr: z.number().optional(), // For blanket % check
  operating_margin: z.number().optional(), // For blanket % check
});
export type OperatingScenarioEntry = z.infer<typeof OperatingScenarioEntry>;

export const OperatingScenarioSet = z.object({
  artifact_type: z.literal("operating_scenario_set"),
  probability_bear: z.number(),
  probability_base: z.number(),
  probability_bull: z.number(),
  scenarios: z.array(OperatingScenarioEntry).min(3),
});
export type OperatingScenarioSet = z.infer<typeof OperatingScenarioSet>;

export const SegmentForecast = z.object({
  segment_name: z.string().min(1),
  // null when the sources do not disclose segment revenue; never a placeholder 0.
  forecast_revenue: z.number().nullable(),
  forecast_operating_income: z.number(),
});

export const OperatingModel = z.object({
  artifact_type: z.literal("operating_model"),
  segments: z.array(SegmentForecast).min(1),
  consolidated_revenue: z.number(),
  consolidated_operating_income: z.number(),
  credit_capital_required: z.number().default(0),
  balance_sheet_effect_present: z.boolean().default(false),
});
export type OperatingModel = z.infer<typeof OperatingModel>;

export const TopDownBottomUpReconciliation = z.object({
  artifact_type: z.literal("top_down_bottom_up_reconciliation"),
  top_down_forecast_total: z.number().nullable(),
  bottom_up_forecast_total: z.number(),
  tam_limit: z.number().nullable(),
  customer_budget_limit: z.number().nullable(),
});
export type TopDownBottomUpReconciliation = z.infer<typeof TopDownBottomUpReconciliation>;

export const ReinvestmentModel = z.object({
  artifact_type: z.literal("reinvestment_model"),
  capex_forecast: z.array(z.number()),
  working_capital_forecast: z.array(z.number()),
});
export type ReinvestmentModel = z.infer<typeof ReinvestmentModel>;

export const ForecastArtifactSet = z.union([
  DriverTree,
  OperatingScenarioSet,
  OperatingModel,
  TopDownBottomUpReconciliation,
  ReinvestmentModel,
]);
export type ForecastArtifactSet = z.infer<typeof ForecastArtifactSet>;
