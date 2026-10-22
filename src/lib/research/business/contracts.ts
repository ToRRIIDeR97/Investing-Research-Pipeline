/**
 * Business analysis contracts (Component 8) for Research OS v3.
 */

import { z } from "zod/v4";

export const MarketplaceDetails = z.object({
  buyers: z.string().min(1),
  transactions: z.string().min(1),
  gmv: z.string().min(1),
  take_rate: z.string().min(1),
});
export type MarketplaceDetails = z.infer<typeof MarketplaceDetails>;

export const LenderDetails = z.object({
  funding_cost: z.string().min(1),
  credit_losses: z.string().min(1),
});
export type LenderDetails = z.infer<typeof LenderDetails>;

export const SegmentDetails = z.object({
  segment_name: z.string().min(1),
  product_or_service: z.string().min(1),
  customer_or_end_user: z.string(),
  revenue_model: z.string().min(1),
  contract_structure: z.string().min(1),
  pricing_unit: z.string().min(1),
  costs_and_reinvestment: z.string().min(1),
  working_capital_mechanics: z.string().min(1),
  suppliers_or_complements: z.array(z.string().min(1)).min(1),
  competitors_or_substitutes: z.array(z.string().min(1)).min(1),
  regulation: z.string().min(1),
  revenue_recognition_and_cash_conversion_chain: z.string().min(1),
  marketplace_details: MarketplaceDetails.optional(),
  lender_details: LenderDetails.optional(),
});
export type SegmentDetails = z.infer<typeof SegmentDetails>;

export const SegmentModel = z.object({
  artifact_type: z.literal("segment_model"),
  segments: z.array(SegmentDetails).min(1),
});
export type SegmentModel = z.infer<typeof SegmentModel>;

export const CustomerDecision = z.object({
  customer_group: z.string().min(1),
  problem_initiating_demand: z.string().min(1),
  economic_value_or_roi: z.string().min(1),
  budget_owner: z.string().min(1),
  alternatives: z.array(z.string().min(1)).min(1),
  purchase_criteria: z.array(z.string().min(1)).min(1),
  deployment_constraints: z.array(z.string().min(1)).min(1),
  renewal_replacement_or_repeat_purchase_mechanism: z.string().min(1),
  churn_or_cancellation_triggers: z.array(z.string().min(1)).min(1),
  switching_or_multihoming_path: z.string().min(1),
  time_to_financial_effect: z.string().min(1),
});
export type CustomerDecision = z.infer<typeof CustomerDecision>;

export const CustomerDecisionMap = z.object({
  artifact_type: z.literal("customer_decision_map"),
  customer_groups: z.array(CustomerDecision).min(1),
});
export type CustomerDecisionMap = z.infer<typeof CustomerDecisionMap>;

export const ProcessNodeOutcomes = z.object({
  downside: z.string().min(1),
  central: z.string().min(1),
  upside: z.string().min(1),
});

export const ProcessNode = z.object({
  process_node: z.string().min(1),
  starting_condition: z.string().min(1),
  decision_maker: z.string().min(1),
  trigger: z.string().min(1),
  economic_incentive: z.string().min(1),
  required_resources: z.array(z.string().min(1)).min(1),
  main_constraint: z.string().min(1),
  downside_central_upside_outcomes: ProcessNodeOutcomes,
  competitive_response: z.string().min(1),
  time_lag: z.string().min(1),
  financial_line_affected: z.string().min(1),
  leading_indicator: z.string().min(1),
  failure_condition: z.string().min(1),
  supporting_claim_ids: z.array(z.guid()).min(1),
  confidence: z.number().min(0).max(1),
});
export type ProcessNode = z.infer<typeof ProcessNode>;

export const BusinessProcessMap = z.object({
  artifact_type: z.literal("business_process_map"),
  process_nodes: z.array(ProcessNode).min(1),
});
export type BusinessProcessMap = z.infer<typeof BusinessProcessMap>;

export const Bottleneck = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  /** null when no capacity is disclosed; the constraint is then described in description. */
  capacity_limit: z.number().positive().nullable(),
  unit: z.string().min(1),
  current_utilization: z.number().min(0).max(1),
  mitigation_strategy: z.string().min(1),
});
export type Bottleneck = z.infer<typeof Bottleneck>;

export const BottleneckRegister = z.object({
  artifact_type: z.literal("bottleneck_register"),
  bottlenecks: z.array(Bottleneck).min(1),
});
export type BottleneckRegister = z.infer<typeof BottleneckRegister>;

export const ResponseScenario = z.object({
  scenario_name: z.string().min(1),
  threat_description: z.string().min(1),
  response_mechanism: z.string().min(1),
  time_to_response: z.string().min(1),
  financial_impact: z.string().min(1),
});
export type ResponseScenario = z.infer<typeof ResponseScenario>;

export const CompetitorEntry = z.object({
  competitor_name: z.string().min(1),
  /** Listed ticker, so code can attach the peer's SEC numbers (peer_benchmark); omitted for private competitors. */
  ticker: z.string().max(12).optional(),
  /** "peer_benchmark.peers.<TICKER>" when the peer's numbers are stored, otherwise why they are not. */
  peer_metrics: z.string().max(300).optional(),
  /** null when the share is not disclosed. */
  market_share: z.number().min(0).max(1).nullable(),
  main_advantages: z.array(z.string().min(1)).min(1),
  response_scenarios: z.array(ResponseScenario).min(1),
});
export type CompetitorEntry = z.infer<typeof CompetitorEntry>;

export const CompetitiveResponseMatrix = z.object({
  artifact_type: z.literal("competitive_response_matrix"),
  competitors: z.array(CompetitorEntry).min(1),
});
export type CompetitiveResponseMatrix = z.infer<typeof CompetitiveResponseMatrix>;

/** Management scored on separate axes, so weak governance can sit beside strong execution (JD example section 10). */
export const MANAGEMENT_AXES = ["operating_execution", "balance_sheet_discipline", "capital_returns", "capital_allocation", "governance_alignment"] as const;
export const ManagementAxis = z.object({
  axis: z.enum(MANAGEMENT_AXES),
  /** 1-5, or null when the evidence can't support a score. */
  score: z.number().min(1).max(5).nullable(),
  rationale: z.string().min(1),
  /** Paths into code-computed artifacts, for example financial_analytics.capital_allocation.quarterly. */
  analytics_paths: z.array(z.string().min(1)),
  supporting_claim_ids: z.array(z.guid()),
});
export const ManagementAssessment = z.object({
  artifact_type: z.literal("management_assessment"),
  axes: z.array(ManagementAxis).length(MANAGEMENT_AXES.length),
  summary: z.string().min(1),
});
export type ManagementAssessment = z.infer<typeof ManagementAssessment>;

export const BusinessArtifactSet = z.union([
  SegmentModel,
  CustomerDecisionMap,
  BusinessProcessMap,
  BottleneckRegister,
  CompetitiveResponseMatrix,
]);
export type BusinessArtifactSet = z.infer<typeof BusinessArtifactSet>;
