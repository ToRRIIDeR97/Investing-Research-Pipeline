/**
 * Moat contracts (Component 9) for Research OS v3.
 */

import { z } from "zod/v4";

export const MOAT_CLASSES = ["unproven", "weak", "moderate", "strong", "exceptional"] as const;
const score = z.number().int().min(0).max(5);
export const MoatScores = z.object({
  current_strength: score, breadth_across_revenue: score, replication_difficulty: score,
  pricing_power: score, attack_resistance: score, expected_durability: score,
});

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
  /** Framework §7.6 classification. Code caps strong and exceptional at moderate without history and peer paths. */
  classification: z.enum(MOAT_CLASSES),
  /** Framework §7.6 dimensions, reduced to six, each 0-5. */
  scores: MoatScores,
  supporting_claim_ids: z.array(z.guid()),
  /** Paths into computed artifacts the moat is tested against, for example financial_analytics.segments.quarterly or peer_benchmark.peers. */
  artifact_paths: z.array(z.string().min(1)),
  /** Set by code when it lowers the classification. */
  classification_note: z.string().optional(),
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
  /** The claimed_moat of the moat_assessment entry this attack tests. */
  targets_moat: z.string().min(1),
  survives: z.enum(["fully", "partially", "not_at_all"]),
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
