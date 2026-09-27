/**
 * Company genesis and strategic identity artifact contracts for Research OS v3.
 */

import { z } from "zod/v4";

export const FounderMotivation = z.enum([
  "personal_problem",
  "mission_or_cause",
  "technical_conviction",
  "commercial_opportunity",
  "financial_ambition",
  "competitive_ambition",
  "professional_frustration",
  "status_or_legacy",
  "mixed",
  "unknown",
]);

export type FounderMotivation = z.infer<typeof FounderMotivation>;

export const EvidenceWeight = z.enum([
  "contemporary_direct_founder_statement",
  "later_retrospective_founder_statement",
  "contemporary_third_party_observation",
  "documented_company_action",
  "analyst_inference",
  "disputed_corporate_account",
]);

export type EvidenceWeight = z.infer<typeof EvidenceWeight>;

export const HistoricalClaim = z.object({
  claim: z.string().min(1),
  evidence_weight: EvidenceWeight,
  evidence_claim_ids: z.array(z.guid()).min(1, "A material claim must link to evidence"),
  confidence: z.number().min(0).max(1),
  alternative_interpretations: z.array(z.string()).optional(),
  contradictions: z.array(z.string()).optional(),
});

export type HistoricalClaim = z.infer<typeof HistoricalClaim>;

export const CompanyGenesis = z.object({
  artifact_type: z.literal("company_genesis"),
  pre_founding_environment: z.string().min(1),
  customer_problem: z.string().min(1),
  incumbent_failure: z.string().min(1),
  enabling_change: z.string().min(1),
  founder_background: z.string().min(1),
  founder_motivations: z.array(z.object({
    motivation: FounderMotivation,
    evidence_claim_ids: z.array(z.guid()).min(1),
    confidence: z.number().min(0).max(1),
  })).min(1),
  alternative_motivation_interpretations: z.array(z.string()).min(1),
  original_product: z.string().min(1),
  original_customer: z.string().min(1),
  original_geography: z.string().min(1),
  original_revenue_model: z.string().min(1),
  initial_funding: z.string().min(1),
  early_constraints: z.string().min(1),
  first_proof_point: z.string().min(1),
  early_failure_or_near_failure: z.string().optional(),
  present_day_implications: z.array(z.string().min(1)).min(1),
  material_claims: z.array(HistoricalClaim).min(1),
});

export type CompanyGenesis = z.infer<typeof CompanyGenesis>;

export const FounderProfile = z.object({
  artifact_type: z.literal("founder_profile"),
  founder_name: z.string().min(1),
  background_summary: z.string().min(1),
  motivations: z.array(z.object({
    motivation: FounderMotivation,
    evidence_claim_ids: z.array(z.guid()).min(1),
    confidence: z.number().min(0).max(1),
  })).min(1),
  alternative_interpretations: z.array(z.string()).min(1),
  control_evolution: z.string().min(1),
  influence_today: z.string().min(1),
});

export type FounderProfile = z.infer<typeof FounderProfile>;

export const StrategicHistoryEvent = z.object({
  date_or_period: z.string().min(1),
  event: z.string().min(1),
  objective_at_the_time: z.string().min(1),
  decision: z.string().min(1),
  evidence_claim_ids: z.array(z.guid()).min(1),
  immediate_effect: z.string().min(1),
  lasting_consequence: z.string().min(1),
  strategy_changed: z.boolean(),
  mission_changed: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export type StrategicHistoryEvent = z.infer<typeof StrategicHistoryEvent>;

export const StrategicHistoryTimeline = z.object({
  artifact_type: z.literal("strategic_history_timeline"),
  events: z.array(StrategicHistoryEvent).min(1),
  major_pivots: z.array(z.string().min(1)).min(1),
});

export type StrategicHistoryTimeline = z.infer<typeof StrategicHistoryTimeline>;

export const StrategicDNA = z.object({
  artifact_type: z.literal("strategic_dna"),
  persistent_behaviors: z.array(z.string().min(1)).min(1),
  decision_patterns: z.array(z.string().min(1)).min(1),
  capital_allocation_habits: z.array(z.string().min(1)).min(1),
  talent_and_organization_patterns: z.array(z.string().min(1)).min(1),
  historical_evidence: z.array(HistoricalClaim).min(1),
  current_implications: z.array(z.string().min(1)).min(1),
});

export type StrategicDNA = z.infer<typeof StrategicDNA>;

export const MissionEvolution = z.object({
  artifact_type: z.literal("mission_evolution"),
  original_mission: z.string().min(1),
  mission_changes: z.array(z.object({
    date_or_period: z.string().min(1),
    new_mission: z.string().min(1),
    evidence_claim_ids: z.array(z.guid()).min(1),
  })).min(1),
  current_mission: z.string().min(1),
  gap_or_inconsistency: z.string().optional(),
});

export type MissionEvolution = z.infer<typeof MissionEvolution>;

export const GenesisArtifactSet = z.union([
  CompanyGenesis,
  FounderProfile,
  StrategicHistoryTimeline,
  StrategicDNA,
  MissionEvolution,
]);

export type GenesisArtifactSet = z.infer<typeof GenesisArtifactSet>;
