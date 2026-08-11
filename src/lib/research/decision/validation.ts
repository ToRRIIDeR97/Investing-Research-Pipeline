/**
 * Validators for thesis, risks, catalysts,expected return, and monitoring.
 */

import {
  InvestmentThesis,
  RiskRegister,
  CatalystRegister,
  ExpectedReturnMatrix,
  ThesisBreakers,
  MonitoringDashboard,
  DecisionRecord,
} from "./contracts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function calculateProbabilityWeightedReturn(
  returns: Pick<ExpectedReturnMatrix, "bear_return" | "base_return" | "bull_return">,
  probabilities: { probability_bear: number; probability_base: number; probability_bull: number }
): number {
  return Number((returns.bear_return * probabilities.probability_bear
    + returns.base_return * probabilities.probability_base
    + returns.bull_return * probabilities.probability_bull).toFixed(6));
}

export function validateInvestmentThesis(content: unknown): ValidationResult {
  const parsed = InvestmentThesis.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C12-T3: Thesis generated before accepted valuation
  if (!data.valuation_accepted_first) {
    errors.push("Investment thesis cannot be finalized before the valuation is accepted.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateRiskRegister(content: unknown): ValidationResult {
  const parsed = RiskRegister.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const risk of data.risks) {
    // C12-T1: Source gap submitted as operating risk without mechanism
    if (risk.is_source_gap_only) {
      errors.push(`Risk '${risk.risk_name}' is classified as a source gap only; it must describe an operational risk with a causal mechanism.`);
    }

    if (risk.risk_name.toLowerCase().includes("system-identified") || risk.risk_name.toLowerCase().includes("placeholder")) {
      errors.push(`Risk '${risk.risk_name}' contains placeholder name.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateCatalystRegister(content: unknown): ValidationResult {
  const parsed = CatalystRegister.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const cat of data.catalysts) {
    // C12-T2: Business driver submitted as catalyst without event
    if (cat.is_business_driver_only) {
      errors.push(`Catalyst '${cat.catalyst_name}' is a continuous business driver without an event or measurable transition.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateExpectedReturnMatrix(content: unknown): ValidationResult {
  const parsed = ExpectedReturnMatrix.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C12-T6: Expected return omits dilution
  if (data.dilution_omitted) {
    errors.push("Expected return calculation cannot omit dilution effects when estimating shareholder returns.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateThesisBreakers(content: unknown): ValidationResult {
  const parsed = ThesisBreakers.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const breaker of data.breakers) {
    // C12-T4: Thesis breaker lacks threshold
    if (!breaker.threshold || breaker.threshold.trim().length === 0 || breaker.threshold.toLowerCase() === "none") {
      errors.push(`Thesis breaker '${breaker.name}' lacks a measurable threshold.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateMonitoringDashboard(content: unknown): ValidationResult {
  const parsed = MonitoringDashboard.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  for (const item of data.items) {
    // C12-T5: Monitoring KPI has no model input
    if (!item.model_input_affected || item.model_input_affected.trim().length === 0 || item.model_input_affected.toLowerCase() === "none") {
      errors.push(`Monitoring KPI '${item.kpi}' lacks an affected model input link.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateDecisionRecord(content: unknown): ValidationResult {
  const parsed = DecisionRecord.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C12-T8: Decision attempts approval without human record
  if (data.decision === "approve" && (!data.human_approved_by || data.human_approved_by.trim().length === 0)) {
    errors.push("Decision record cannot be approved without a human approver name.");
  }

  return { valid: errors.length === 0, errors, warnings };
}
