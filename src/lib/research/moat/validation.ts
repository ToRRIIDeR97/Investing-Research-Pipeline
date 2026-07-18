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
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
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

export function validateMoatAttackMatrix(content: unknown): ValidationResult {
  const parsed = MoatAttackMatrix.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
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
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
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
