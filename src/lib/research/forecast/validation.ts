/**
 * Validators for forecast, operating model, and scenario engine.
 */

import {
  DriverTree,
  OperatingScenarioSet,
  OperatingModel,
  TopDownBottomUpReconciliation,
} from "./contracts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateDriverTree(content: unknown): ValidationResult {
  const parsed = DriverTree.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C10-T1: Revenue CAGR entered without driver decomposition
  for (const driver of data.drivers) {
    const isRevenue = driver.driver_key.toLowerCase().includes("revenue");
    const noDecomposition = !driver.formula_decomposition ||
                            driver.formula_decomposition.toLowerCase().includes("cagr") && driver.formula_decomposition.trim().split(" ").length === 1;
    if (isRevenue && noDecomposition) {
      errors.push(`Driver '${driver.driver_key}' enters revenue CAGR without operational driver decomposition.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateOperatingScenarioSet(content: unknown): ValidationResult {
  const parsed = OperatingScenarioSet.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C10-T3: Scenario probabilities total 0.95 or 1.05
  const totalProb = data.probability_bear + data.probability_base + data.probability_bull;
  if (Math.abs(totalProb - 1.0) > 1e-5) {
    errors.push(`Scenario probabilities must total exactly 1.0, but got ${totalProb}.`);
  }

  const bear = data.scenarios.find((s) => s.scenario_type === "bear");
  const base = data.scenarios.find((s) => s.scenario_type === "base");
  const bull = data.scenarios.find((s) => s.scenario_type === "bull");

  if (bear && base && bull) {
    // C10-T2: Bear case is base case minus 20% on all lines (blanket percentage changes)
    if (bear.revenue_cagr && base.revenue_cagr && bear.operating_margin && base.operating_margin) {
      const revRatio = bear.revenue_cagr / base.revenue_cagr;
      const marginRatio = bear.operating_margin / base.operating_margin;
      if (Math.abs(revRatio - 0.8) < 1e-3 && Math.abs(marginRatio - 0.8) < 1e-3) {
        errors.push("Bear case cannot be a blanket 20% reduction of the base case; it must model distinct business-process outcomes.");
      }
    }

    // C10-T7: Bull case assumes stronger moat and lower maintenance spend without evidence
    const bullMoatStronger = bull.moat_state.toLowerCase().includes("stronger") || bull.moat_state.toLowerCase().includes("expanding");
    if (bullMoatStronger && bull.maintenance_spend !== undefined && base.maintenance_spend !== undefined) {
      if (bull.maintenance_spend < base.maintenance_spend) {
        errors.push("Bull case assumes a stronger/expanding moat but models lower maintenance spending than the base case, which is incoherent.");
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateOperatingModel(content: unknown): ValidationResult {
  const parsed = OperatingModel.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C10-T4: Segment revenue does not equal consolidated revenue
  const segmentRevenueSum = data.segments.reduce((acc, s) => acc + s.forecast_revenue, 0);
  if (Math.abs(segmentRevenueSum - data.consolidated_revenue) > 1e-2) {
    errors.push(`Segment revenue sum (${segmentRevenueSum}) does not reconcile to consolidated revenue (${data.consolidated_revenue}).`);
  }

  // C10-T6: Growth requires credit capital but no balance-sheet effect exists
  if (data.credit_capital_required > 0 && !data.balance_sheet_effect_present) {
    errors.push("Operating model requires credit capital but models no corresponding balance-sheet effect.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateTopDownBottomUpReconciliation(content: unknown): ValidationResult {
  const parsed = TopDownBottomUpReconciliation.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C10-T5: Forecast exceeds TAM or customer budget
  if (data.bottom_up_forecast_total > data.tam_limit) {
    errors.push(`Bottom-up forecast (${data.bottom_up_forecast_total}) exceeds the TAM limit (${data.tam_limit}).`);
  }
  if (data.bottom_up_forecast_total > data.customer_budget_limit) {
    errors.push(`Bottom-up forecast (${data.bottom_up_forecast_total}) exceeds the customer budget limit (${data.customer_budget_limit}).`);
  }

  return { valid: errors.length === 0, errors, warnings };
}
