/**
 * Validators for moat proof and attack matrix.
 */

import {
  MoatAssessment,
  MoatAttackMatrix,
  NoMoatCounterfactual,
} from "./contracts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateMoatAssessment(content: unknown): ValidationResult {
  const parsed = MoatAssessment.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const a of data.assessments) {
    const isBrand = a.claimed_moat.toLowerCase().includes("brand");
    const isNetworkEffect = a.claimed_moat.toLowerCase().includes("network effect") || a.claimed_moat.toLowerCase().includes("network-effect");

    // C9-T1: "High margins" is the only moat evidence -> Rejected
    const hasOnlyHighMargins = a.financial_evidence.length === 1 &&
      (a.financial_evidence[0].toLowerCase().includes("high margins") || a.financial_evidence[0].toLowerCase().includes("high margin"));
    if (hasOnlyHighMargins) {
      errors.push(`Moat assessment for '${a.claimed_moat}' lists 'high margins' as the only evidence, which is circular.`);
    }

    // C9-T2: Network-effect claim with declining engagement per participant
    if (isNetworkEffect && a.engagement_per_participant !== undefined && a.engagement_per_participant < 0) {
      errors.push(`Network-effect claim for '${a.claimed_moat}' shows declining engagement per participant (${a.engagement_per_participant}), contradicting the moat thesis.`);
    }

    // C9-T3: Brand moat with no maintenance spending
    if (isBrand) {
      const noSpending = a.maintenance_requirement.toLowerCase().includes("no spend") ||
                         a.maintenance_requirement.toLowerCase().includes("no maintenance spend") ||
                         a.maintenance_requirement.toLowerCase().includes("none") ||
                         a.maintenance_requirement.trim().length === 0;
      if (noSpending) {
        errors.push(`Brand moat '${a.claimed_moat}' must specify a maintenance reinvestment requirement.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

const HISTORY_PATH = /^(financial_analytics|historical_record|historical_diagnosis)\b/;
const PEER_PATH = /^peer_benchmark\b/;

/**
 * Framework §7.7: a moat rated strong or exceptional must be tested against the multi-year record and against peers.
 * Without a history path and a peer path code caps it at moderate and says why; it never raises a rating.
 */
export function capMoatClassifications<T extends { assessments: Array<{ classification: string; artifact_paths: string[]; classification_note?: string }> }>(assessment: T): T {
  return { ...assessment, assessments: assessment.assessments.map((entry) => {
    if (!["strong", "exceptional"].includes(entry.classification)) return entry;
    const missing = [!entry.artifact_paths.some((p) => HISTORY_PATH.test(p)) && "history", !entry.artifact_paths.some((p) => PEER_PATH.test(p)) && "peer"].filter(Boolean);
    return missing.length ? { ...entry, classification: "moderate",
      classification_note: `Rated ${entry.classification} by the analyst; capped at moderate without ${missing.join(" and ")} evidence paths.` } : entry;
  }) };
}

/** Every attack names a moat the assessment lists. */
export function attackTargetErrors(assessment: { assessments: { claimed_moat: string }[] }, matrix: { attacks: { targets_moat: string; primary_attacker: string }[] }) {
  const moats = new Set(assessment.assessments.map((a) => a.claimed_moat.trim().toLowerCase()));
  return matrix.attacks.filter((a) => !moats.has(a.targets_moat.trim().toLowerCase()))
    .map((a) => `Attack by '${a.primary_attacker}' targets '${a.targets_moat}', which is not a claimed_moat in moat_assessment.`);
}

export function validateMoatAttackMatrix(content: unknown): ValidationResult {
  const parsed = MoatAttackMatrix.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const attack of data.attacks) {
    // C9-T4: Attack has no financial translation
    const noFinancialTranslation = attack.financial_translation.toLowerCase().includes("none") ||
                                   attack.financial_translation.toLowerCase().includes("no financial translation") ||
                                   attack.financial_translation.trim().length < 5;
    if (noFinancialTranslation) {
      errors.push(`Attack scenario by '${attack.primary_attacker}' has no financial translation.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateNoMoatCounterfactual(content: unknown): ValidationResult {
  const parsed = NoMoatCounterfactual.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C9-T5: No-moat counterfactual duplicates bear case without changed economics
  if (data.changed_economics_description.toLowerCase().includes("same as bear case") ||
      data.changed_economics_description.toLowerCase().includes("duplicate bear") ||
      data.changed_economics_description.trim().length < 10) {
    errors.push("No-moat counterfactual must demonstrate distinct changed economics from the base/bear cases.");
  }

  return { valid: errors.length === 0, errors, warnings };
}
