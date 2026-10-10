// Shared fixtures for the decision-synthesis determinism acceptance tests.
import assert from "node:assert/strict";

export const CLAIM_A = "11111111-1111-4111-8111-111111111111";
export const CLAIM_B = "22222222-2222-4222-8222-222222222222";
export const INVENTED = "89383f80-0000-4000-8000-000000000000";

/** Loads the planned module and fails on the missing export instead of crashing the file. */
export async function loadFinalize() {
  let mod: Record<string, any> = {};
  // A variable specifier keeps tsc from resolving a module that exists only after implementation.
  const modulePath = "../../../src/lib/research/decision/finalize";
  try { mod = await import(modulePath); } catch { mod = {}; }
  for (const name of ["finalizeDecisionOutput", "decisionOutputFormat"]) {
    assert.equal(typeof mod[name], "function", `src/lib/research/decision/finalize.ts must export ${name}`);
  }
  return mod as { finalizeDecisionOutput: (raw: unknown, inputs: any) => any; decisionOutputFormat: (inputs: any) => any };
}

export const risk = (name: string, extra: Record<string, unknown> = {}) => ({
  risk_name: name,
  causal_mechanism: `${name} reduces operating income.`,
  probability: 0.3, severity: 3, exposure: 0.9,
  leading_indicator: "Quarterly capex", failure_threshold: "Capex above 33,000",
  financial_consequence: "Lower free cash flow", model_input_affected: "capex",
  mitigants: ["Capex discipline"], supporting_claim_ids: [CLAIM_A], confidence: 0.7,
  ...extra,
});

export const catalyst = (name: string, extra: Record<string, unknown> = {}) => ({
  catalyst_name: name, expected_date_range: "Q4 2026",
  event_mechanism: `${name} changes the revenue outlook.`,
  probability: 0.5, direction: "upside", model_input_affected: "revenue_growth",
  evidence: "Company guidance", ...extra,
});

/**
 * A model answer that passes DECISION_SYNTHESIS_CONTRACT on main except for one deliberate
 * difference: dilution_omitted is true. That flag becomes code-owned (AC-6), so the new
 * model-facing format must accept it (AC-8).
 */
export function rawDecision(overrides: Record<string, any> = {}) {
  return {
    investment_thesis: {
      artifact_type: "investment_thesis",
      thesis_statement: "Capex intensity caps free cash flow through FY2028.",
      causal_chain: "AI capex rises faster than revenue, so free cash flow falls.",
      market_mispricing: "The market prices a return to 2024 margins.",
      must_be_true: ["Capex stays above 40% of revenue"],
      disproving_evidence: ["Capex guidance cut"],
      horizon: "3 years",
      expected_return_linkage: "Model-written linkage.",
      valuation_accepted_first: true,
    },
    risk_register: { artifact_type: "risk_register", risks: [risk("Capex-driven compression of free cash flow")] },
    catalyst_register: { artifact_type: "catalyst_register", catalysts: [catalyst("Q3 2026 earnings release")] },
    expected_return_matrix: {
      artifact_type: "expected_return_matrix",
      bear_return: 0.9, base_return: 0.9, bull_return: 0.9, probability_weighted_return: 0.9,
      no_rerating_return: 0.04, weak_stock_outcome: -0.2, permanent_loss_limit: -0.35, dilution_omitted: true,
    },
    thesis_breakers: { artifact_type: "thesis_breakers", breakers: [{ name: "FCF negative", threshold: "Two quarters below zero", model_consequence: "Bear case applies" }] },
    monitoring_dashboard: {
      artifact_type: "monitoring_dashboard",
      items: [{
        kpi: "Capex", metric_key: "capex", definition: "Purchases of property and equipment", unit: "USD millions",
        reporting_basis: "gaap", process_node: "Reinvestment", current_level: 30116, bear_threshold: 33000,
        base_range: "27,500 to 33,000", bull_threshold: 27500, reporting_frequency: "quarterly",
        model_input_affected: "capex", source_role: "regulatory_filing",
      }],
    },
    confidence_assessment: { artifact_type: "confidence_assessment", data: 0.6, history: 0.6, process: 0.6, moat: 0.6, forecast: 0.5, valuation: 0.4, downside: 0.5 },
    decision_record: { artifact_type: "decision_record", decision: "pending", rationale: "Human review is the approval gate." },
    ...overrides,
  };
}

export const completeInputs = (extra: Record<string, unknown> = {}) => ({
  acceptedClaimIds: [CLAIM_A, CLAIM_B],
  valuation: { status: "complete", terminalYear: 2028 },
  marketPrice: 719.87,
  terminalReturns: { bear: -0.4, base: -0.2, bull: 0.1 },
  probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 },
  dilutionCovered: true,
  ...extra,
});

export const withheldInputs = (extra: Record<string, unknown> = {}) => ({
  acceptedClaimIds: [CLAIM_A, CLAIM_B],
  valuation: { status: "withheld", terminalYear: 2028, withheldReason: "Operating scenarios cover only FY2026." },
  marketPrice: 719.87,
  terminalReturns: null,
  probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 },
  dilutionCovered: true,
  ...extra,
});

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
