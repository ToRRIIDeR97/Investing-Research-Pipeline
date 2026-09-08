/**
 * Validators for valuation methods and annual price target paths.
 */

import {
  AnnualPriceTargetPath,
  ValuationScenarioSet,
  ReverseValuation,
} from "./contracts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateAnnualPriceTargetPath(
  content: unknown,
  scenarioSet?: { terminal_year: number; terminal_anchor_bear: number; terminal_anchor_base: number; terminal_anchor_bull: number; uses_adjusted_fcf: boolean; segments_reconciled: boolean; },
  marketPrice?: number
): ValidationResult {
  const parsed = AnnualPriceTargetPath.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const data = parsed.data;

  // C11-T10: Scenario currency differs from market price currency
  if (data.currency !== data.market_price_currency) {
    errors.push(`Scenario currency '${data.currency}' differs from market price currency '${data.market_price_currency}' without an explicit conversion rate.`);
  }

  // Find all years
  const targetYears = Array.from(new Set(data.price_target_path.map((p) => p.fiscal_year))).sort((a, b) => a - b);
  if (targetYears.length === 0) {
    errors.push("Price target path is empty.");
  }

  // C11-T5: Missing intermediate forecast year
  if (targetYears.length > 1) {
    const minYear = targetYears[0];
    const maxYear = targetYears[targetYears.length - 1];
    for (let y = minYear; y <= maxYear; y++) {
      if (!targetYears.includes(y)) {
        errors.push(`Missing intermediate forecast year: ${y}`);
      }
    }
  }

  for (const entry of data.price_target_path) {
    // C11-T7: Linear interpolation submitted without operating calculations
    if (entry.is_interpolated) {
      errors.push(`Price target for year ${entry.fiscal_year} in scenario '${entry.scenario_type}' is linearly interpolated without operating calculations.`);
    }

    // C11-T13: MELI uses unadjusted CFO-minus-capex as economic FCF -> Valuation gate blocks FCF-derived targets
    const isFCFMethod = entry.valuation_method.toLowerCase().includes("fcf") || entry.valuation_method.toLowerCase().includes("cash flow");
    if (isFCFMethod && scenarioSet && !scenarioSet.uses_adjusted_fcf) {
      errors.push(`Valuation method '${entry.valuation_method}' is blocked because unadjusted FCF is used for a fintech-heavy company.`);
    }

    // C11-T14: Segment shares/margins do not reconcile -> SOTP blocked
    const isSOTP = entry.valuation_method.toLowerCase().includes("sotp") || entry.valuation_method.toLowerCase().includes("sum of parts") || entry.valuation_method.toLowerCase().includes("sum-of-parts");
    if (isSOTP && scenarioSet && !scenarioSet.segments_reconciled) {
      errors.push(`SOTP method '${entry.valuation_method}' is blocked because segment assumptions do not reconcile to consolidated results.`);
    }

    if (Number.isFinite(marketPrice) && Number(marketPrice) > 0) {
      const expectedReturn = (entry.price_target + entry.dividend_per_share) / Number(marketPrice) - 1;
      if (Math.abs(entry.total_return_target - expectedReturn) > 1e-3) {
        errors.push(`Total return for ${entry.fiscal_year} ${entry.scenario_type} must be cumulative from the current market price (${Number(marketPrice)}); expected ${expectedReturn.toFixed(6)}, got ${entry.total_return_target}.`);
      }
    }
  }

  if (scenarioSet) {
    for (const year of targetYears) {
      const rows = data.price_target_path.filter((entry) => entry.fiscal_year === year);
      const bear = rows.find((entry) => entry.scenario_type === "bear");
      const base = rows.find((entry) => entry.scenario_type === "base");
      const bull = rows.find((entry) => entry.scenario_type === "bull");
      if (!bear || !base || !bull) {
        errors.push(`Price target path for ${year} must include bear, base, and bull scenarios.`);
      } else if (!(bear.price_target < base.price_target && base.price_target < bull.price_target)) {
        errors.push(`Price targets for ${year} must be ordered bear < base < bull.`);
      }
    }
  }

  // C11-T6: Final-year path differs from terminal anchor
  if (scenarioSet && targetYears.length > 0) {
    const finalYear = targetYears[targetYears.length - 1];
    if (finalYear === scenarioSet.terminal_year) {
      const bearFinal = data.price_target_path.find((p) => p.fiscal_year === finalYear && p.scenario_type === "bear");
      const baseFinal = data.price_target_path.find((p) => p.fiscal_year === finalYear && p.scenario_type === "base");
      const bullFinal = data.price_target_path.find((p) => p.fiscal_year === finalYear && p.scenario_type === "bull");

      if (bearFinal && Math.abs(bearFinal.price_target - scenarioSet.terminal_anchor_bear) > 1e-2) {
        errors.push(`Bear final-year price target (${bearFinal.price_target}) differs from terminal anchor (${scenarioSet.terminal_anchor_bear}).`);
      }
      if (baseFinal && Math.abs(baseFinal.price_target - scenarioSet.terminal_anchor_base) > 1e-2) {
        errors.push(`Base final-year price target (${baseFinal.price_target}) differs from terminal anchor (${scenarioSet.terminal_anchor_base}).`);
      }
      if (bullFinal && Math.abs(bullFinal.price_target - scenarioSet.terminal_anchor_bull) > 1e-2) {
        errors.push(`Bull final-year price target (${bullFinal.price_target}) differs from terminal anchor (${scenarioSet.terminal_anchor_bull}).`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateValuationScenarioSet(content: unknown): ValidationResult {
  const parsed = ValuationScenarioSet.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const probabilityTotal = parsed.data.probability_bear + parsed.data.probability_base + parsed.data.probability_bull;
  if (Math.abs(probabilityTotal - 1) > 0.001) {
    errors.push(`Valuation scenario probabilities total ${probabilityTotal}, expected 1.`);
  }
  if (!(parsed.data.terminal_anchor_bear < parsed.data.terminal_anchor_base
    && parsed.data.terminal_anchor_base < parsed.data.terminal_anchor_bull)) {
    errors.push("Valuation scenario anchors must be ordered bear < base < bull.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function validateReverseValuation(content: unknown): ValidationResult {
  const parsed = ReverseValuation.safeParse(content);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.errors.map((e) => e.message), warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const expectedSpread = parsed.data.return_on_equity - parsed.data.cost_of_equity;
  if (Math.abs(parsed.data.roe_minus_cost_of_equity - expectedSpread) > 1e-3) {
    errors.push(`ROE-minus-cost-of-equity spread must equal ROE minus cost of equity; expected ${expectedSpread.toFixed(6)}, got ${parsed.data.roe_minus_cost_of_equity}.`);
  }
  return { valid: errors.length === 0, errors, warnings };
}
