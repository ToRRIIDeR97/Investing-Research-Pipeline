/**
 * Decision contracts (Component 12) for Research OS v3.
 */

import { z } from "zod";

export const InvestmentThesis = z.object({
  artifact_type: z.literal("investment_thesis"),
  thesis_statement: z.string().min(1),
  causal_chain: z.string().min(1),
  market_mispricing: z.string().min(1),
  must_be_true: z.array(z.string().min(1)).min(1),
  disproving_evidence: z.array(z.string().min(1)).min(1),
  horizon: z.string().min(1),
  expected_return_linkage: z.string().min(1),
  valuation_accepted_first: z.boolean().default(true),
});
export type InvestmentThesis = z.infer<typeof InvestmentThesis>;

export const RiskEntry = z.object({
  risk_name: z.string().min(1),
  causal_mechanism: z.string().min(1),
  probability: z.number().min(0).max(1),
  severity: z.number().min(1).max(5),
  exposure: z.number(),
  leading_indicator: z.string().min(1),
  failure_threshold: z.string().min(1),
  financial_consequence: z.string().min(1),
  model_input_affected: z.string().min(1),
  mitigants: z.array(z.string().min(1)).min(1),
  supporting_claim_ids: z.array(z.string().uuid()).min(1),
  confidence: z.number().min(0).max(1),
  is_source_gap_only: z.boolean().default(false), // For C12-T1 check
});
export type RiskEntry = z.infer<typeof RiskEntry>;

export const RiskRegister = z.object({
  artifact_type: z.literal("risk_register"),
  risks: z.array(RiskEntry).min(1),
});
export type RiskRegister = z.infer<typeof RiskRegister>;

export const CatalystEntry = z.object({
  catalyst_name: z.string().min(1),
  expected_date_range: z.string().min(1),
  event_mechanism: z.string().min(1), // Must not be just a generic driver
  probability: z.number().min(0).max(1),
  direction: z.enum(["upside", "downside"]),
  model_input_affected: z.string().min(1),
  evidence: z.string().min(1),
  is_business_driver_only: z.boolean().default(false), // For C12-T2 check
});
export type CatalystEntry = z.infer<typeof CatalystEntry>;

export const CatalystRegister = z.object({
  artifact_type: z.literal("catalyst_register"),
  catalysts: z.array(CatalystEntry).min(1),
});
export type CatalystRegister = z.infer<typeof CatalystRegister>;

export const ExpectedReturnMatrix = z.object({
  artifact_type: z.literal("expected_return_matrix"),
  bear_return: z.number(),
  base_return: z.number(),
  bull_return: z.number(),
  probability_weighted_return: z.number(),
  no_rerating_return: z.number(),
  weak_stock_outcome: z.number(),
  permanent_loss_limit: z.number(),
  prediction_date: z.string().optional(),
  prediction_price: z.number().finite().optional(),
  horizon_months: z.literal(12).optional(),
  return_unit: z.literal("decimal").optional(),
  benchmark_symbol: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  rows: z.array(z.object({
    scenario_type: z.enum(["bear", "base", "bull"]),
    target_date: z.string().min(1),
    target_price: z.number().finite(),
    dividend_per_share: z.number().finite(),
    total_return: z.number().finite(),
    probability: z.number().min(0).max(1),
    weighted_contribution: z.number().finite(),
  })).length(3).optional(),
  dilution_omitted: z.boolean().default(false), // For C12-T6 check
});
export type ExpectedReturnMatrix = z.infer<typeof ExpectedReturnMatrix>;

export const ThesisBreaker = z.object({
  name: z.string().min(1),
  threshold: z.string(), // C12-T4 check: must not be empty
  model_consequence: z.string().min(1),
});
export type ThesisBreaker = z.infer<typeof ThesisBreaker>;

export const ThesisBreakers = z.object({
  artifact_type: z.literal("thesis_breakers"),
  breakers: z.array(ThesisBreaker).min(1),
});
export type ThesisBreakers = z.infer<typeof ThesisBreakers>;

export const MonitoringKPI = z.object({
  metric_key: z.string().min(1).default("unmapped"),
  kpi: z.string().min(1),
  process_node: z.string().min(1),
  current_level: z.number(),
  bear_threshold: z.number(),
  base_range: z.string().min(1),
  bull_threshold: z.number(),
  reporting_frequency: z.string().min(1),
  model_input_affected: z.string(), // C12-T5 check: must not be empty
  source_role: z.string().min(1),
  history: z.array(z.object({
    period_end: z.string().min(1),
    value: z.number().finite(),
    unit: z.string(),
    currency: z.string().nullable().optional(),
  })).max(4).optional(),
});
export type MonitoringKPI = z.infer<typeof MonitoringKPI>;

export const MonitoringDashboard = z.object({
  artifact_type: z.literal("monitoring_dashboard"),
  items: z.array(MonitoringKPI).min(1),
});
export type MonitoringDashboard = z.infer<typeof MonitoringDashboard>;

export const ConfidenceAssessment = z.object({
  artifact_type: z.literal("confidence_assessment"),
  data: z.number().min(0).max(1),
  history: z.number().min(0).max(1),
  process: z.number().min(0).max(1),
  moat: z.number().min(0).max(1),
  forecast: z.number().min(0).max(1),
  valuation: z.number().min(0).max(1),
  downside: z.number().min(0).max(1),
});
export type ConfidenceAssessment = z.infer<typeof ConfidenceAssessment>;

export const DecisionRecord = z.object({
  artifact_type: z.literal("decision_record"),
  decision: z.enum(["approve", "reject", "pending"]),
  rationale: z.string().min(1),
  human_approved_by: z.string().optional(), // C12-T8 check: must be present for approve
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

export const DecisionArtifactSet = z.union([
  InvestmentThesis,
  RiskRegister,
  CatalystRegister,
  ExpectedReturnMatrix,
  ThesisBreakers,
  MonitoringDashboard,
  ConfidenceAssessment,
  DecisionRecord,
]);
export type DecisionArtifactSet = z.infer<typeof DecisionArtifactSet>;
