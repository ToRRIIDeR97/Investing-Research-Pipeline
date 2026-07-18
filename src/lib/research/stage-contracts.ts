// Stage-specific output contracts for artifact-producing handlers.
// Each contract defines the exact keys the model must output, replacing
// the generic "asset-analyst" schema that previously caused contract
// mismatches between agent enforcement and handler persistence.
import type { AgentOutputFormat } from "@/lib/agent-harness/types";

/** Build a schema contract that works with both parseStructuredOutput & validateSchema */
function contract(requiredKeys: string[]): AgentOutputFormat {
  return {
    requiredKeys,
    schema: {
      type: "object",
      required: requiredKeys,
      additionalProperties: true,
    },
  };
}

/** Contract: company-genesis output */
export const COMPANY_GENESIS_CONTRACT = contract([
  "company_genesis",
  "founder_profile",
  "strategic_history_timeline",
  "strategic_dna",
]);

/** Contract: historical-diagnosis output */
export const HISTORICAL_DIAGNOSIS_CONTRACT = contract([
  "historical_diagnosis",
]);

/** Contract: business-process-analysis output */
export const BUSINESS_PROCESS_CONTRACT = contract([
  "segment_model",
  "customer_decision_map",
  "business_process_map",
  "bottleneck_map",
  "competitive_response_matrix",
]);

/** Contract: moat-analysis output */
export const MOAT_CONTRACT = contract([
  "moat_assessment",
  "moat_attack_matrix",
  "no_moat_counterfactual",
]);

/** Contract: operating-model output */
export const OPERATING_MODEL_CONTRACT = contract([
  "driver_tree",
  "operating_model",
]);

/** Contract: operating-scenarios output */
export const OPERATING_SCENARIOS_CONTRACT = contract([
  "operating_scenario_set",
]);

/** Contract: asset-valuation output */
export const VALUATION_CONTRACT = contract([
  "valuation_scenario_set",
  "reverse_valuation",
  "annual_price_target_path",
]);

/** Contract: decision-synthesis output */
export const DECISION_SYNTHESIS_CONTRACT = contract([
  "investment_thesis",
  "risk_register",
  "catalyst_register",
  "expected_return_matrix",
  "thesis_breakers",
  "monitoring_dashboard",
  "confidence_assessment",
  "decision_record",
]);

/** Contract: ai-reviewer output */
export const AI_REVIEWER_CONTRACT = contract([
  "review_summary",
  "findings",
  "quality_score",
  "recommendations",
  "review_verdict",
]);

/** Map from stage key to its output contract */
export const STAGE_OUTPUT_CONTRACTS: Record<string, AgentOutputFormat> = {
  company_genesis: COMPANY_GENESIS_CONTRACT,
  historical_diagnosis: HISTORICAL_DIAGNOSIS_CONTRACT,
  business_process_analysis: BUSINESS_PROCESS_CONTRACT,
  moat_analysis: MOAT_CONTRACT,
  operating_model: OPERATING_MODEL_CONTRACT,
  operating_scenarios: OPERATING_SCENARIOS_CONTRACT,
  asset_valuation: VALUATION_CONTRACT,
  decision_synthesis: DECISION_SYNTHESIS_CONTRACT,
  ai_reviewer: AI_REVIEWER_CONTRACT,
};

/**
 * Return the stage-specific output contract for a stage key.
 * Returns undefined for stages that don't have a specialized contract
 * (e.g., intake, source_discovery, etc.).
 */
export function getStageOutputContract(stageKey: string): AgentOutputFormat | undefined {
  return STAGE_OUTPUT_CONTRACTS[stageKey];
}
