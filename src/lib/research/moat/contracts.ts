/**
 * Moat contracts (Component 9) for Research OS v3.
 */

import { z } from "zod/v4";

export const MoatAssessmentEntry = z.object({
  claimed_moat: z.string().min(1),
  moat_source: z.string().min(1),
  protected_profit_pool: z.string().min(1),
  customer_consequence: z.string().min(1),
  competitor_consequence: z.string().min(1),
  company_value_capture: z.string().min(1),
  financial_evidence: z.array(z.string().min(1)).min(1),
  operating_evidence: z.array(z.string().min(1)).min(1),
  maintenance_requirement: z.string().min(1),
  current_strength: z.string().min(1),
  durability: z.string().min(1),
  decay_velocity: z.string().min(1),
  failure_indicators: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  engagement_per_participant: z.number().optional(), // For network-effect check
});
export type MoatAssessmentEntry = z.infer<typeof MoatAssessmentEntry>;

export const MoatAssessment = z.object({
  artifact_type: z.literal("moat_assessment"),
  assessments: z.array(MoatAssessmentEntry).min(1),
});
export type MoatAssessment = z.infer<typeof MoatAssessment>;

export const MoatAttackEntry = z.object({
  primary_attacker: z.string().min(1),
  attack_mechanism: z.string().min(1),
  capital_and_time_required: z.string().min(1),
  first_vulnerable_customer: z.string().min(1),
  switching_path: z.string().min(1),
  incumbent_defense: z.string().min(1),
  leading_indicators: z.array(z.string().min(1)).min(1),
  financial_translation: z.string().min(1),
  residual_moat: z.string().min(1),
});
export type MoatAttackEntry = z.infer<typeof MoatAttackEntry>;

export const MoatAttackMatrix = z.object({
  artifact_type: z.literal("moat_attack_matrix"),
  attacks: z.array(MoatAttackEntry).min(1),
});
export type MoatAttackMatrix = z.infer<typeof MoatAttackMatrix>;

export const NoMoatCounterfactual = z.object({
  artifact_type: z.literal("no_moat_counterfactual"),
  expected_margin_no_moat: z.number(),
  expected_growth_no_moat: z.number(),
  expected_reinvestment_no_moat: z.number(),
  changed_economics_description: z.string().min(1),
  bear_case_margin_reconciliation: z.string().min(1),
});
export type NoMoatCounterfactual = z.infer<typeof NoMoatCounterfactual>;

export const MoatArtifactSet = z.union([
  MoatAssessment,
  MoatAttackMatrix,
  NoMoatCounterfactual,
]);
export type MoatArtifactSet = z.infer<typeof MoatArtifactSet>;
