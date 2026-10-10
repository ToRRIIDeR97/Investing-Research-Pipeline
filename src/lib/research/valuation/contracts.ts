/**
 * Valuation contracts (Component 11) for Research OS v3.
 */

import { z } from "zod/v4";
import {ValuationMethodInput} from './schedules';

export const AnnualProjectionEntry = z.object({
  fiscal_year: z.number().int(),
  target_date: z.string().min(1),
  operating_values: z.record(z.string(), z.number()),
  balance_sheet_values: z.record(z.string(), z.number()),
  per_share_values: z.record(z.string(), z.number()),
});
export type AnnualProjectionEntry = z.infer<typeof AnnualProjectionEntry>;

export const PriceTargetEntry = z.object({
  fiscal_year: z.number().int(),
  scenario_type: z.enum(["bear", "base", "bull"]),
  valuation_method: z.string().min(1),
  operating_metric_key: z.string().min(1),
  operating_metric_value: z.number(),
  valuation_parameter_key: z.string().min(1),
  valuation_parameter_value: z.number(),
  price_target: z.number(),
  dividend_per_share: z.number(),
  total_return_target: z.number(),
  is_interpolated: z.boolean().default(false),
});
export type PriceTargetEntry = z.infer<typeof PriceTargetEntry>;

export const AnnualPriceTargetPath = z.object({
  artifact_type: z.literal("annual_price_target_path"),
  currency: z.string().min(1),
  market_price_currency: z.string().min(1),
  annual_projections: z.array(AnnualProjectionEntry).min(1),
  price_target_path: z.array(PriceTargetEntry).min(1),
});
export type AnnualPriceTargetPath = z.infer<typeof AnnualPriceTargetPath>;

export const ValuationScenarioSet = z.object({
  artifact_type: z.literal("valuation_scenario_set"),
  terminal_year: z.number().int(),
  terminal_anchor_bear: z.number(),
  terminal_anchor_base: z.number(),
  terminal_anchor_bull: z.number(),
  uses_adjusted_fcf: z.boolean().default(true),
  segments_reconciled: z.boolean().default(true),
  method_inputs:z.array(ValuationMethodInput).optional(),
  omitted_methods:z.array(z.object({method:z.string().min(1),reason:z.string().min(1)})).optional(),
  valuation_status:z.enum(["complete","withheld"]).optional(),
  withheld_reason:z.string().optional(),
});
export type ValuationScenarioSet = z.infer<typeof ValuationScenarioSet>;

/**
 * The reason when the valuation analyst deliberately withheld the valuation: status withheld,
 * every terminal anchor exactly 0 and a stated reason. Anything else (mixed or missing anchors)
 * is not a withheld outcome and stays a validation failure.
 */
export function withheldValuationReason(set: unknown): string | null {
  const value = (set ?? {}) as Record<string, unknown>;
  if (value.valuation_status !== "withheld") return null;
  if (!["bear", "base", "bull"].every((scenario) => value[`terminal_anchor_${scenario}`] === 0)) return null;
  const reason = [value.withheld_reason, value.terminal_anchor_note].find((text) => typeof text === "string" && text.trim());
  return reason ? String(reason).trim() : null;
}

export const ReverseValuation = z.object({
  artifact_type: z.literal("reverse_valuation"),
  implied_growth: z.number(),
  implied_margin: z.number(),
});
export type ReverseValuation = z.infer<typeof ReverseValuation>;

export const ValuationArtifactSet = z.union([
  AnnualPriceTargetPath,
  ValuationScenarioSet,
  ReverseValuation,
]);
export type ValuationArtifactSet = z.infer<typeof ValuationArtifactSet>;
