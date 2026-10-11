import test from "node:test";
import assert from "node:assert/strict";
import { CLAIM_A, INVENTED, catalyst, clone, completeInputs, loadFinalize, rawDecision, risk, withheldInputs } from "./fixtures";
import { WITHHELD_VALUATION_LINKAGE } from "../../../src/lib/research/decision/validation";

test("AC-1: a catalyst flagged as a business driver moves to the monitoring drivers; the rest stay", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision({
    catalyst_register: { artifact_type: "catalyst_register", catalysts: [
      catalyst("Q3 2026 earnings release"),
      catalyst("Reality Labs cost decisions or revenue inflection", { is_business_driver_only: true }),
    ] },
  });
  const result = finalizeDecisionOutput(raw, completeInputs());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.output.catalyst_register.catalysts.map((c: any) => c.catalyst_name), ["Q3 2026 earnings release"]);
  const drivers = result.output.monitoring_dashboard.drivers;
  assert.equal(drivers.length, 1);
  assert.equal(drivers[0].name, "Reality Labs cost decisions or revenue inflection");
  assert.equal(drivers[0].mechanism, "Reality Labs cost decisions or revenue inflection changes the revenue outlook.");
  assert.deepEqual(result.adjustments.moved_catalysts, [{ catalyst_name: "Reality Labs cost decisions or revenue inflection", reason: "business_driver_only" }]);
});

test("AC-2: a risk flagged as a source gap becomes an open evidence gap instead of a risk", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision({
    risk_register: { artifact_type: "risk_register", risks: [
      risk("Capex-driven compression of free cash flow"),
      risk("Unverified market price and missing discount-rate inputs", { is_source_gap_only: true }),
    ] },
  });
  const result = finalizeDecisionOutput(raw, completeInputs());
  assert.deepEqual(result.output.risk_register.risks.map((r: any) => r.risk_name), ["Capex-driven compression of free cash flow"]);
  assert.deepEqual(result.adjustments.moved_risks, [{ risk_name: "Unverified market price and missing discount-rate inputs", reason: "source_gap_only" }]);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].owner, "system:decision-synthesis");
  assert.equal(result.gaps[0].severity, "medium");
  assert.match(result.gaps[0].description, /Unverified market price and missing discount-rate inputs/);
});

test("AC-3: invented citations are dropped and recorded outside the rationale prose", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision({
    risk_register: { artifact_type: "risk_register", risks: [risk("Capex-driven compression of free cash flow", { supporting_claim_ids: [CLAIM_A, INVENTED] })] },
  });
  const result = finalizeDecisionOutput(raw, completeInputs());
  assert.deepEqual(result.output.risk_register.risks[0].supporting_claim_ids, [CLAIM_A]);
  assert.deepEqual(result.adjustments.dropped_citation_ids, [INVENTED]);
  assert.equal(result.output.decision_record.rationale, "Human review is the approval gate.");
  assert.deepEqual(result.output.decision_record.adjustments, result.adjustments);
});

test("AC-3: a risk whose citations are all invented moves to the gaps", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision({
    risk_register: { artifact_type: "risk_register", risks: [
      risk("Capex-driven compression of free cash flow"),
      risk("Regulatory fine in the EU", { supporting_claim_ids: [INVENTED] }),
    ] },
  });
  const result = finalizeDecisionOutput(raw, completeInputs());
  assert.deepEqual(result.output.risk_register.risks.map((r: any) => r.risk_name), ["Capex-driven compression of free cash flow"]);
  assert.deepEqual(result.adjustments.moved_risks, [{ risk_name: "Regulatory fine in the EU", reason: "no_supporting_evidence" }]);
  assert.equal(result.gaps.length, 1);
});

test("AC-4: the stage fails only when a register ends up empty", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision({
    catalyst_register: { artifact_type: "catalyst_register", catalysts: [catalyst("Ad pricing trend", { is_business_driver_only: true })] },
  });
  const result = finalizeDecisionOutput(raw, completeInputs());
  assert.ok(result.errors.some((e: any) => e.path === "catalyst_register"), "an empty catalyst register is an error");
});

test("AC-5: code sets the thesis fields when the valuation is complete, whatever the model wrote", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision();
  raw.investment_thesis.valuation_accepted_first = false;
  const result = finalizeDecisionOutput(raw, completeInputs());
  assert.equal(result.output.investment_thesis.valuation_accepted_first, true);
  assert.match(result.output.investment_thesis.expected_return_linkage, /^Fiscal 2028 diluted-share price targets imply bear -40\.0%, base -20\.0%, and bull 10\.0% total returns from \$719\.87/);
  assert.equal(result.output.investment_thesis.horizon, "Through fiscal 2028");
});

test("AC-5: code marks a withheld conclusion even when the model omits the marker", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision();
  raw.investment_thesis.expected_return_linkage = "No reliable target exists.";
  raw.investment_thesis.valuation_accepted_first = true;
  const result = finalizeDecisionOutput(raw, withheldInputs());
  assert.equal(result.output.investment_thesis.valuation_accepted_first, false);
  assert.equal(result.output.investment_thesis.expected_return_linkage, `${WITHHELD_VALUATION_LINKAGE} No reliable target exists.`);
  assert.equal(result.output.decision_record.decision, "pending");
});

test("AC-6: returns come from code: estimated when complete, null when withheld", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const complete = finalizeDecisionOutput(rawDecision(), completeInputs()).output.expected_return_matrix;
  assert.equal(complete.status, "estimated");
  assert.deepEqual([complete.bear_return, complete.base_return, complete.bull_return], [-0.4, -0.2, 0.1]);
  assert.equal(complete.probability_weighted_return, -0.175);
  assert.equal(complete.no_rerating_return, 0.04, "judgment fields stay as the model wrote them");
  assert.equal(complete.dilution_omitted, false);

  const withheld = finalizeDecisionOutput(rawDecision(), withheldInputs()).output.expected_return_matrix;
  assert.equal(withheld.status, "withheld");
  for (const key of ["bear_return", "base_return", "bull_return", "probability_weighted_return", "no_rerating_return", "weak_stock_outcome", "permanent_loss_limit"]) {
    assert.equal(withheld[key], null, `${key} is null when the valuation is withheld`);
  }
});

test("AC-6: finalizing does not mutate the model answer", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision();
  const before = clone(raw);
  finalizeDecisionOutput(raw, withheldInputs());
  assert.deepEqual(raw, before);
});
