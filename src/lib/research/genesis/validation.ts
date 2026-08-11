/**
 * Validators for company genesis and strategic identity artifacts.
 */

import {
  CompanyGenesis,
  FounderProfile,
  StrategicHistoryTimeline,
  StrategicDNA,
  MissionEvolution,
  type EvidenceWeight,
} from "./contracts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

const EVIDENCE_WEIGHT_RANK: Record<EvidenceWeight, number> = {
  contemporary_direct_founder_statement: 5,
  contemporary_third_party_observation: 4,
  documented_company_action: 4,
  later_retrospective_founder_statement: 3,
  analyst_inference: 2,
  disputed_corporate_account: 1,
};

export function validateGenesisArtifact(content: unknown): ValidationResult {
  const parsed = CompanyGenesis.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  const data = parsed.data;
  if (!data.founder_motivations.some((m) => m.motivation !== "unknown")) {
    // Unknown is an intentional fail-closed value when the source packet does
    // not support a motivation. Rejecting it here would force the model to
    // invent a supported motivation just to satisfy the workflow gate.
    warnings.push("Founder motivation remains unknown because no supported motivation was evidenced.");
  }

  for (const claim of data.material_claims) {
    if (claim.evidence_weight === "analyst_inference" && claim.confidence > 0.6) {
      warnings.push(`Claim '${claim.claim.substring(0, 40)}...' is analyst inference with high confidence`);
    }
    if (claim.evidence_weight === "disputed_corporate_account" && claim.confidence > 0.7) {
      warnings.push(`Claim '${claim.claim.substring(0, 40)}...' relies on disputed corporate account with high confidence`);
    }
  }

  if (data.present_day_implications.length < 1) {
    errors.push("At least one present-day analytical implication is required.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateFounderProfile(content: unknown): ValidationResult {
  const parsed = FounderProfile.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;
  if (data.motivations.every((m) => m.motivation === "unknown")) {
    warnings.push("Founder motivations remain unknown because no supported motivation was evidenced.");
  }
  if (data.alternative_interpretations.length === 0) {
    errors.push("At least one alternative interpretation is required.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function validateStrategicHistoryTimeline(content: unknown): ValidationResult {
  const parsed = StrategicHistoryTimeline.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;
  for (const event of data.events) {
    if (!event.date_or_period || event.date_or_period.length < 4) {
      errors.push(`Event '${event.event}' lacks a usable date or period.`);
    }
    if (event.evidence_claim_ids.length === 0) {
      errors.push(`Event '${event.event}' has no evidence claim IDs.`);
    }
  }
  if (data.major_pivots.length === 0) {
    errors.push("At least one major strategic pivot must be identified.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function validateStrategicDNA(content: unknown): ValidationResult {
  const parsed = StrategicDNA.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;
  if (data.historical_evidence.length < 2) {
    warnings.push("Strategic DNA has limited historical evidence; no additional claims were inferred.");
  }
  if (data.current_implications.length === 0) {
    errors.push("At least one current implication is required.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function validateMissionEvolution(content: unknown): ValidationResult {
  const parsed = MissionEvolution.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;
  if (data.mission_changes.length < 1) {
    errors.push("Mission evolution requires at least one recorded change.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function evidenceWeightRank(weight: EvidenceWeight): number {
  return EVIDENCE_WEIGHT_RANK[weight] ?? 0;
}

export function prefersContemporaryEvidence(claims: { evidence_weight: EvidenceWeight }[]): boolean {
  if (claims.length === 0) return false;
  const rank = Math.max(...claims.map((c) => evidenceWeightRank(c.evidence_weight)));
  return rank >= 4;
}
