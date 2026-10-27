import { z } from "zod";

export const ARTIFACT_STATUSES = [
  "planned",
  "collecting_evidence",
  "evidence_only",
  "draft",
  "needs_more_work",
  "validated",
  "accepted",
  "superseded",
  "rejected",
] as const;

export const ASSUMPTION_CLASSIFICATIONS = [
  "disclosed_fact",
  "third_party_data",
  "derived_estimate",
  "analyst_assumption",
  "speculative_option",
] as const;

export const artifactStatusSchema = z.enum(ARTIFACT_STATUSES);

export const artifactValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  checkedAt: z.string().datetime(),
});

export const artifactContentSchema = z.record(z.string(), z.unknown()).default({});

export const researchArtifactSchema = z.object({
  id: z.string().guid(),
  research_run_id: z.string().guid(),
  asset_id: z.string().guid(),
  profile_id: z.string().guid().optional(),
  artifact_type: z.string().min(1),
  scope_key: z.string().min(1),
  artifact_version: z.number().int().positive(),
  status: artifactStatusSchema,
  content_json: artifactContentSchema,
  schema_version: z.string().min(1),
  validator_version: z.string().min(1),
  prompt_version: z.string().min(1),
  validation_result_json: artifactValidationResultSchema,
  created_by: z.string().min(1),
  supersedes_artifact_id: z.string().guid().optional(),
  accepted_at: z.string().datetime().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const researchArtifactDependencySchema = z.object({
  id: z.string().guid(),
  artifact_id: z.string().guid(),
  depends_on_artifact_id: z.string().guid(),
  dependency_type: z.enum(["required", "supports"]),
  created_at: z.string().datetime(),
});

export const researchArtifactClaimLinkSchema = z.object({
  id: z.string().guid(),
  artifact_id: z.string().guid(),
  evidence_claim_id: z.string().guid(),
  support_type: z.enum(["supports", "contradicts", "context"]),
  created_at: z.string().datetime(),
});

export const researchAssumptionSchema = z.object({
  id: z.string().guid(),
  research_run_id: z.string().guid(),
  assumption_key: z.string().min(1),
  assumption_category: z.string().min(1),
  value_numeric: z.number().optional(),
  value_text: z.string().optional(),
  unit: z.string().optional(),
  currency: z.string().optional(),
  range_low: z.number().optional(),
  range_high: z.number().optional(),
  classification: z.enum(ASSUMPTION_CLASSIFICATIONS),
  causal_mechanism: z.string().optional(),
  time_lag: z.string().optional(),
  falsification_condition: z.string().optional(),
  model_input_path: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(["draft", "validated", "accepted", "superseded", "rejected"]),
  assumption_version: z.number().int().positive(),
  supersedes_assumption_id: z.string().guid().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const researchAssumptionClaimLinkSchema = z.object({
  id: z.string().guid(),
  assumption_id: z.string().guid(),
  evidence_claim_id: z.string().guid(),
  support_type: z.enum(["supports", "contradicts", "context"]),
  created_at: z.string().datetime(),
});

export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;
export type ArtifactValidationResult = z.infer<typeof artifactValidationResultSchema>;
export type ResearchArtifact = z.infer<typeof researchArtifactSchema>;
export type ResearchArtifactInput = Omit<ResearchArtifact, "id" | "created_at" | "updated_at">;
export type ResearchArtifactDependency = z.infer<typeof researchArtifactDependencySchema>;
export type ResearchArtifactClaimLink = z.infer<typeof researchArtifactClaimLinkSchema>;
export type ResearchAssumption = z.infer<typeof researchAssumptionSchema>;
export type ResearchAssumptionInput = Omit<ResearchAssumption, "id" | "created_at" | "updated_at">;
export type ResearchAssumptionClaimLink = z.infer<typeof researchAssumptionClaimLinkSchema>;

export interface ArtifactAcceptanceCheck {
  canAccept: boolean;
  errors: string[];
  warnings: string[];
}

export const artifactTypes = {
  decision_context: "decision_context",
  composable_research_profile: "composable_research_profile",
  source_role_plan: "source_role_plan",
  source_coverage_matrix: "source_coverage_matrix",
  company_genesis: "company_genesis",
  strategic_history_timeline: "strategic_history_timeline",
  strategic_dna: "strategic_dna",
  twenty_quarter_history: "twenty_quarter_history",
  historical_diagnosis: "historical_diagnosis",
  segment_model: "segment_model",
  customer_decision_map: "customer_decision_map",
  business_process_map: "business_process_map",
  bottleneck_register: "bottleneck_register",
  competitive_response_matrix: "competitive_response_matrix",
  moat_assessment: "moat_assessment",
  moat_attack_matrix: "moat_attack_matrix",
  no_moat_counterfactual: "no_moat_counterfactual",
  driver_tree: "driver_tree",
  operating_model: "operating_model",
  operating_scenario_set: "operating_scenario_set",
  top_down_bottom_up_reconciliation: "top_down_bottom_up_reconciliation",
  reinvestment_model: "reinvestment_model",
  valuation_method_run: "valuation_method_run",
  valuation_scenario_set: "valuation_scenario_set",
  annual_price_target_path: "annual_price_target_path",
  reverse_valuation: "reverse_valuation",
  investment_thesis: "investment_thesis",
  risk_register: "risk_register",
  catalyst_register: "catalyst_register",
  expected_return_matrix: "expected_return_matrix",
  thesis_breakers: "thesis_breakers",
  monitoring_dashboard: "monitoring_dashboard",
  confidence_assessment: "confidence_assessment",
  decision_record: "decision_record",
  ai_review_findings: "ai_review_findings",
  export_manifest: "export_manifest",
} as const;

export type ArtifactType = keyof typeof artifactTypes;
