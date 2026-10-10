import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { finalizeDecisionOutput, type DecisionFinalizeInputs } from "@/lib/research/decision/finalize";
import { validateArtifactContent } from "@/lib/research/stage-contracts";
import { generateMarkdownReport } from "@/lib/export/report-generator";

const CLAIM = "11111111-1111-4111-8111-111111111111";
const INVENTED = "99999999-0000-4000-8000-000000000000";

const risk = (name: string, extra: Record<string, unknown> = {}) => ({
  risk_name: name, causal_mechanism: `${name} lowers margins.`, probability: 0.3, severity: 3, exposure: 1,
  leading_indicator: "Margin", failure_threshold: "Below 20%", financial_consequence: "Lower EPS",
  model_input_affected: "operating_margin", mitigants: ["Pricing"], supporting_claim_ids: [CLAIM], confidence: 0.6, ...extra,
});
const catalyst = (name: string, extra: Record<string, unknown> = {}) => ({
  catalyst_name: name, expected_date_range: "Q1 2027", event_mechanism: `${name} resets guidance.`, probability: 0.4,
  direction: "upside", model_input_affected: "revenue_growth", evidence: "Guidance", ...extra,
});
const answer = (overrides: Record<string, unknown> = {}) => ({
  investment_thesis: {
    artifact_type: "investment_thesis", thesis_statement: "Margins recover.", causal_chain: "Costs fall.",
    market_mispricing: "Priced for decline.", must_be_true: ["Costs fall"], disproving_evidence: ["Costs rise"],
    horizon: "3 years", expected_return_linkage: "Model linkage.", valuation_accepted_first: false,
  },
  risk_register: { artifact_type: "risk_register", risks: [risk("Margin pressure")] },
  catalyst_register: { artifact_type: "catalyst_register", catalysts: [catalyst("Investor day")] },
  expected_return_matrix: {
    artifact_type: "expected_return_matrix", bear_return: 0.5, base_return: 0.5, bull_return: 0.5, probability_weighted_return: 0.5,
    no_rerating_return: 0.03, weak_stock_outcome: -0.1, permanent_loss_limit: -0.3, dilution_omitted: false,
  },
  thesis_breakers: { artifact_type: "thesis_breakers", breakers: [{ name: "Margin collapse", threshold: "Below 10%", model_consequence: "Bear case" }] },
  monitoring_dashboard: { artifact_type: "monitoring_dashboard", items: [{
    kpi: "Operating margin", metric_key: "operating_margin", definition: "Operating income over revenue", unit: "percent",
    reporting_basis: "gaap", process_node: "Cost base", current_level: 0.25, bear_threshold: 0.2, base_range: "20-30%",
    bull_threshold: 0.3, reporting_frequency: "quarterly", model_input_affected: "operating_margin", source_role: "regulatory_filing",
  }] },
  confidence_assessment: { artifact_type: "confidence_assessment", data: 0.5, history: 0.5, process: 0.5, moat: 0.5, forecast: 0.5, valuation: 0.5, downside: 0.5 },
  decision_record: { artifact_type: "decision_record", decision: "pending", rationale: "Awaiting review." },
  ...overrides,
});
const inputs = (extra: Partial<DecisionFinalizeInputs> = {}): DecisionFinalizeInputs => ({
  acceptedClaimIds: [CLAIM], valuation: { status: "complete", terminalYear: 2029 }, marketPrice: 50,
  terminalReturns: { bear: -0.2, base: 0.1, bull: 0.4 },
  probabilities: { probability_bear: 0.2, probability_base: 0.6, probability_bull: 0.2 }, dilutionCovered: true, ...extra,
});

describe("decision finalize step", () => {
  it("is idempotent: a finalized output finalizes to itself and opens no new gaps", () => {
    const raw = answer({
      risk_register: { artifact_type: "risk_register", risks: [risk("Margin pressure", { supporting_claim_ids: [CLAIM, INVENTED] }), risk("Missing filings", { is_source_gap_only: true })] },
      catalyst_register: { artifact_type: "catalyst_register", catalysts: [catalyst("Investor day"), catalyst("Ad demand", { is_business_driver_only: true })] },
    });
    for (const valuation of [inputs(), inputs({ valuation: { status: "withheld", withheldReason: "No cash-flow schedule." }, terminalReturns: null })]) {
      const first = finalizeDecisionOutput(raw, valuation);
      const second = finalizeDecisionOutput(first.output, valuation);
      assert.deepEqual(second.output, first.output);
      assert.deepEqual(second.gaps, []);
      assert.deepEqual(second.errors, []);
      assert.deepEqual(second.output.decision_record.adjustments, first.adjustments);
    }
  });

  it("does not report returns whose inputs omit reported dilution, and keeps the model linkage", () => {
    const { output, errors } = finalizeDecisionOutput(answer(), inputs({ dilutionCovered: false }));
    assert.deepEqual(errors, []);
    const matrix = output.expected_return_matrix;
    assert.equal(matrix.status, "unavailable");
    assert.deepEqual([matrix.bear_return, matrix.base_return, matrix.bull_return, matrix.probability_weighted_return], [null, null, null, null]);
    assert.deepEqual([matrix.no_rerating_return, matrix.weak_stock_outcome, matrix.permanent_loss_limit], [0.03, -0.1, -0.3]);
    assert.equal(matrix.dilution_omitted, false);
    assert.equal(output.investment_thesis.valuation_accepted_first, true);
    assert.equal(output.investment_thesis.expected_return_linkage, "Model linkage.");
    assert.equal(validateArtifactContent("expected_return_matrix", matrix).valid, true);
  });

  it("states returns without weights when no scenario probabilities exist", () => {
    const { output } = finalizeDecisionOutput(answer(), inputs({ probabilities: null }));
    assert.equal(output.expected_return_matrix.status, "estimated");
    assert.equal(output.expected_return_matrix.probability_weighted_return, null);
    assert.equal(output.investment_thesis.expected_return_linkage,
      "Fiscal 2029 diluted-share price targets imply bear -20.0%, base 10.0%, and bull 40.0% total returns from $50.00. " +
      "Future share issuance beyond the reported diluted count remains a source gap.");
  });

  it("moves a source-gap risk that also cites an invented ID once, and keeps gap keys unique", () => {
    const raw = answer({ risk_register: { artifact_type: "risk_register", risks: [
      risk("Margin pressure"),
      risk("Missing segment data", { is_source_gap_only: true, supporting_claim_ids: [INVENTED] }),
      risk("Missing segment data", { supporting_claim_ids: [INVENTED] }),
    ] } });
    const { adjustments, gaps } = finalizeDecisionOutput(raw, inputs());
    assert.deepEqual(adjustments.moved_risks, [
      { risk_name: "Missing segment data", reason: "source_gap_only" },
      { risk_name: "Missing segment data", reason: "no_supporting_evidence" },
    ]);
    assert.deepEqual(adjustments.dropped_citation_ids, [INVENTED]);
    assert.equal(new Set(gaps.map((gap) => gap.gap_key)).size, 2);
  });

  it("keeps older return matrices without a status valid", () => {
    const older = answer().expected_return_matrix;
    assert.equal("status" in older, false);
    assert.equal(validateArtifactContent("expected_return_matrix", older).valid, true);
  });

  it("prints Withheld for a withheld return matrix", () => {
    const { output } = finalizeDecisionOutput(answer(), inputs({ valuation: { status: "withheld", withheldReason: "No schedule." }, terminalReturns: null }));
    const report = generateMarkdownReport({ asset: { canonical_name: "Example", slug: "example", asset_kind: "equity" }, decision: output } as any);
    const section = report.slice(report.indexOf("Expected-return matrix"), report.indexOf("Risks and catalysts"));
    assert.match(section, /Bear Case Return\*\*: Withheld/);
    assert.doesNotMatch(section, /null%|NaN%|\b0%/);
  });
});
