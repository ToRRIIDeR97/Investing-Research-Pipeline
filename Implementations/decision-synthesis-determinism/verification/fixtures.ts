// Independent fixtures: a bank-like asset with different names, IDs and orderings.
import assert from "node:assert/strict";

export const EV1 = "aaaaaaaa-0000-4000-8000-000000000001";
export const EV2 = "aaaaaaaa-0000-4000-8000-000000000002";
export const FAKE1 = "bbbbbbbb-0000-4000-8000-00000000dead";
export const FAKE2 = "bbbbbbbb-0000-4000-8000-00000000beef";

export async function finalizeModule() {
  const modulePath = "../../../src/lib/research/decision/finalize";   // variable: not resolved by tsc before implementation
  const mod: Record<string, any> = await import(modulePath).catch(() => ({}));
  assert.equal(typeof mod.finalizeDecisionOutput, "function", "finalizeDecisionOutput export is missing");
  assert.equal(typeof mod.decisionOutputFormat, "function", "decisionOutputFormat export is missing");
  return mod;
}

const riskEntry = (risk_name: string, ids: string[], more: Record<string, unknown> = {}) => ({
  risk_name, causal_mechanism: "Deposit costs reprice faster than loan yields.", probability: 0.2, severity: 4,
  exposure: 0.8, leading_indicator: "Deposit beta", failure_threshold: "NIM below 5%", financial_consequence: "Lower net interest income",
  model_input_affected: "net_interest_margin", mitigants: ["Fixed-rate loans"], supporting_claim_ids: ids, confidence: 0.6, ...more,
});

const catalystEntry = (catalyst_name: string, more: Record<string, unknown> = {}) => ({
  catalyst_name, expected_date_range: "H1 2027", event_mechanism: "Charter approval allows deposit pricing changes.",
  probability: 0.4, direction: "upside", model_input_affected: "deposit_growth", evidence: "Regulatory filing", ...more,
});

export function bankAnswer(parts: { risks?: any[]; catalysts?: any[]; linkage?: string; acceptedFirst?: boolean } = {}) {
  return {
    investment_thesis: {
      artifact_type: "investment_thesis", thesis_statement: "Deposit funding lowers cost of capital.",
      causal_chain: "Deposits replace warehouse lines, so NIM widens.", market_mispricing: "Valued as a lender.",
      must_be_true: ["Deposit growth above 20%"], disproving_evidence: ["Deposit outflows"], horizon: "5 years",
      expected_return_linkage: parts.linkage ?? "Returns depend on NIM.", valuation_accepted_first: parts.acceptedFirst ?? false,
    },
    risk_register: { artifact_type: "risk_register", risks: parts.risks ?? [riskEntry("Rate cut squeeze", [EV1])] },
    catalyst_register: { artifact_type: "catalyst_register", catalysts: parts.catalysts ?? [catalystEntry("Charter decision")] },
    expected_return_matrix: {
      artifact_type: "expected_return_matrix", bear_return: 0, base_return: 0, bull_return: 0, probability_weighted_return: 0,
      no_rerating_return: 0.12, weak_stock_outcome: -0.1, permanent_loss_limit: -0.3, dilution_omitted: false,
    },
    thesis_breakers: { artifact_type: "thesis_breakers", breakers: [{ name: "Charge-offs", threshold: "Above 6%", model_consequence: "Bear case" }] },
    monitoring_dashboard: { artifact_type: "monitoring_dashboard", items: [{
      kpi: "Deposits", metric_key: "deposits", definition: "Period-end deposits", unit: "USD", reporting_basis: "gaap",
      process_node: "Funding", current_level: null, bear_threshold: 18e9, base_range: "21B-23B", bull_threshold: 25e9,
      reporting_frequency: "quarterly", model_input_affected: "deposit_balance", source_role: "regulatory_filing",
    }] },
    confidence_assessment: { artifact_type: "confidence_assessment", data: 0.7, history: 0.7, process: 0.7, moat: 0.5, forecast: 0.5, valuation: 0.5, downside: 0.5 },
    decision_record: { artifact_type: "decision_record", decision: "pending", rationale: "Awaiting committee." },
  };
}

export { riskEntry, catalystEntry };

export const inputs = (over: Record<string, unknown> = {}) => ({
  acceptedClaimIds: [EV1, EV2],
  valuation: { status: "complete", terminalYear: 2030 },
  marketPrice: 21.5,
  terminalReturns: { bear: -0.1, base: 0.3, bull: 0.8 },
  probabilities: { probability_bear: 0.2, probability_base: 0.6, probability_bull: 0.2 },
  dilutionCovered: true,
  ...over,
});
