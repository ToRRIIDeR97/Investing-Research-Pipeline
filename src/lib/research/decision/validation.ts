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

export type MetricTrend = {
  metric_key: string;
  period_end: string;
  value: number;
  unit: string;
  currency?: string | null;
};

export function buildFourQuarterMetricTrends(rows: MetricTrend[]) {
  const grouped = new Map<string, MetricTrend[]>();
  for (const row of rows) {
    if (!row.metric_key || !row.period_end || !Number.isFinite(row.value)) continue;
    grouped.set(row.metric_key, [...(grouped.get(row.metric_key) || []), row]);
  }
  return Object.fromEntries([...grouped.entries()].map(([key, values]) => [
    key,
    values.sort((left, right) => left.period_end.localeCompare(right.period_end)).slice(-4),
  ]));
}

export function inferPredictionPriceFromTargetPath(priceTargetPath: Record<string, unknown>) {
  const rows = Array.isArray(priceTargetPath.price_target_path)
    ? priceTargetPath.price_target_path as Record<string, unknown>[]
    : [];
  const implied = rows.flatMap((row) => {
    const target = Number(row.price_target);
    const dividend = Number(row.dividend_per_share || 0);
    const totalReturn = Number(row.total_return_target);
    const denominator = 1 + totalReturn;
    const price = (target + dividend) / denominator;
    return Number.isFinite(price) && price > 0 && denominator !== 0 ? [price] : [];
  });
  if (!implied.length) return null;
  const sorted = [...implied].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const tolerance = Math.max(0.01, median * 0.001);
  if (implied.some((price) => Math.abs(price - median) > tolerance)) {
    throw new Error("Accepted valuation rows imply inconsistent prediction prices.");
  }
  return Number(median.toFixed(6));
}

export function deriveExpectedReturnMatrix(input: {
  scenarioSet: Record<string, unknown>;
  priceTargetPath: Record<string, unknown>;
  currentPrice: number;
  predictionDate: string;
}) {
  const rows = Array.isArray(input.priceTargetPath.price_target_path)
    ? input.priceTargetPath.price_target_path as Record<string, unknown>[]
    : [];
  const projectionDates = new Map(
    (Array.isArray(input.priceTargetPath.annual_projections) ? input.priceTargetPath.annual_projections : [])
      .map((projection: any) => [String(projection.fiscal_year), String(projection.target_date || "")])
  );
  const effectiveTargetDate = (row: Record<string, unknown>) => String(
    row.target_date || projectionDates.get(String(row.fiscal_year)) || `${row.fiscal_year}-12-31`
  );
  const predictionTime = Date.parse(input.predictionDate);
  const desiredTime = Number.isFinite(predictionTime)
    ? new Date(predictionTime).setUTCMonth(new Date(predictionTime).getUTCMonth() + 12)
    : NaN;
  const dates = [...new Set(rows.map(effectiveTargetDate).filter(Boolean))];
  const targetDate = dates.sort((left, right) => {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(desiredTime) && Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      const leftAfter = leftTime >= desiredTime;
      const rightAfter = rightTime >= desiredTime;
      if (leftAfter !== rightAfter) return leftAfter ? -1 : 1;
      return leftAfter ? leftTime - rightTime : rightTime - leftTime;
    }
    return left.localeCompare(right);
  })[0];
  const selected = (["bear", "base", "bull"] as const).map((scenarioType) => {
    const row = rows.find((candidate) =>
      String(candidate.scenario_type).toLowerCase() === scenarioType
      && effectiveTargetDate(candidate) === targetDate
    );
    if (!row) throw new Error(`Missing ${scenarioType} valuation row for expected-return horizon ${targetDate || "unknown"}.`);
    const targetPrice = Number(row.price_target);
    const dividend = Number(row.dividend_per_share || 0);
    const probability = Number(input.scenarioSet[`probability_${scenarioType}`]);
    if (![targetPrice, dividend, probability, input.currentPrice].every(Number.isFinite) || input.currentPrice <= 0) {
      throw new Error(`Invalid ${scenarioType} expected-return inputs.`);
    }
    const totalReturn = (targetPrice + dividend) / input.currentPrice - 1;
    return {
      scenario_type: scenarioType,
      target_date: effectiveTargetDate(row),
      target_price: targetPrice,
      dividend_per_share: dividend,
      total_return: Number(totalReturn.toFixed(6)),
      probability,
      weighted_contribution: Number((totalReturn * probability).toFixed(6)),
    };
  });
  const probabilityTotal = selected.reduce((total, row) => total + row.probability, 0);
  if (Math.abs(probabilityTotal - 1) > 0.001) throw new Error(`Expected-return probabilities total ${probabilityTotal}, expected 1.`);
  return {
    rows: selected,
    bear_return: selected.find((row) => row.scenario_type === "bear")!.total_return,
    base_return: selected.find((row) => row.scenario_type === "base")!.total_return,
    bull_return: selected.find((row) => row.scenario_type === "bull")!.total_return,
    probability_weighted_return: Number(selected.reduce((total, row) => total + row.weighted_contribution, 0).toFixed(6)),
    prediction_date: input.predictionDate,
    prediction_price: input.currentPrice,
    horizon_months: 12 as const,
    return_unit: "decimal" as const,
    currency: String(input.priceTargetPath.currency || "USD"),
  };
}

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
  if (data.rows) {
    const probabilityTotal = data.rows.reduce((total, row) => total + row.probability, 0);
    const weightedReturn = data.rows.reduce((total, row) => total + row.weighted_contribution, 0);
    if (Math.abs(probabilityTotal - 1) > 0.001) errors.push("Expected-return row probabilities must sum to 1.");
    if (Math.abs(weightedReturn - data.probability_weighted_return) > 0.001) errors.push("Expected-return row contributions do not reconcile to the probability-weighted return.");
    for (const row of data.rows) {
      const expectedContribution = row.total_return * row.probability;
      if (Math.abs(expectedContribution - row.weighted_contribution) > 0.001) {
        errors.push(`${row.scenario_type} weighted contribution does not equal return times probability.`);
      }
    }
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
    if (item.history?.length) {
      const latest = item.history[item.history.length - 1];
      if (Math.abs(latest.value - item.current_level) > Math.max(1e-9, Math.abs(latest.value) * 1e-9)) {
        errors.push(`Monitoring KPI '${item.kpi}' current level does not equal its latest historical value.`);
      }
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
  if (/\b([a-z][a-z'-]*)\s+\1\b/i.test(data.rationale)) {
    errors.push("Decision rationale contains an adjacent repeated word.");
  }

  return { valid: errors.length === 0, errors, warnings };
}
