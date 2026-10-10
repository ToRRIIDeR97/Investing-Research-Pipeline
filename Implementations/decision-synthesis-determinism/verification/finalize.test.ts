import test from "node:test";
import assert from "node:assert/strict";
import { EV1, EV2, FAKE1, FAKE2, bankAnswer, catalystEntry, finalizeModule, inputs, riskEntry } from "./fixtures";
import { WITHHELD_VALUATION_LINKAGE } from "../../../src/lib/research/decision/validation";
import { validateArtifactContent } from "../../../src/lib/research/stage-contracts";

const withheld = (reason = "No sourced discount rate.") => inputs({ valuation: { status: "withheld", terminalYear: 2030, withheldReason: reason }, terminalReturns: null });

test("AC-1: several flagged catalysts move in their original order; unflagged ones keep theirs", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const raw = bankAnswer({ catalysts: [
    catalystEntry("Driver A", { is_business_driver_only: true }),
    catalystEntry("Charter decision"),
    catalystEntry("Driver B", { is_business_driver_only: true, evidence: "Analyst day" }),
    catalystEntry("Q2 2027 earnings"),
  ] });
  const out = finalizeDecisionOutput(raw, inputs());
  assert.deepEqual(out.output.catalyst_register.catalysts.map((c: any) => c.catalyst_name), ["Charter decision", "Q2 2027 earnings"]);
  assert.deepEqual(out.output.monitoring_dashboard.drivers.map((d: any) => d.name), ["Driver A", "Driver B"]);
  assert.equal(out.output.monitoring_dashboard.drivers[1].evidence, "Analyst day");
  assert.equal(out.output.monitoring_dashboard.items.length, 1, "existing KPI items are untouched");
});

test("AC-2/AC-3: a source-gap risk that also cites a fake ID is moved once, as a source gap", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const raw = bankAnswer({ risks: [riskEntry("Rate cut squeeze", [EV1]), riskEntry("Missing beta source", [FAKE1], { is_source_gap_only: true })] });
  const out = finalizeDecisionOutput(raw, inputs());
  assert.deepEqual(out.adjustments.moved_risks, [{ risk_name: "Missing beta source", reason: "source_gap_only" }]);
  assert.deepEqual(out.adjustments.dropped_citation_ids, [FAKE1]);
  assert.equal(out.gaps.length, 1);
});

test("AC-2: two gap risks get distinct gap keys", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const raw = bankAnswer({ risks: [
    riskEntry("Rate cut squeeze", [EV1]),
    riskEntry("Missing price source!", [EV2], { is_source_gap_only: true }),
    riskEntry("Missing price source?", [EV2], { is_source_gap_only: true }),
  ] });
  const keys = finalizeDecisionOutput(raw, inputs()).gaps.map((g: any) => g.gap_key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
});

test("AC-3: a fake ID cited in several places is recorded once; real IDs survive", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const raw = bankAnswer({ risks: [riskEntry("Rate cut squeeze", [FAKE2, EV1, FAKE2]), riskEntry("Credit losses", [EV2, FAKE2])] });
  const out = finalizeDecisionOutput(raw, inputs());
  assert.deepEqual(out.adjustments.dropped_citation_ids, [FAKE2]);
  assert.deepEqual(out.output.risk_register.risks.map((r: any) => r.supporting_claim_ids), [[EV1], [EV2]]);
  assert.ok(!out.output.decision_record.rationale.includes(FAKE2));
});

test("AC-4: a risk register that empties out is an error even when catalysts are fine", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const raw = bankAnswer({ risks: [riskEntry("Only fake support", [FAKE1]), riskEntry("Only a gap", [EV1], { is_source_gap_only: true })] });
  const out = finalizeDecisionOutput(raw, inputs());
  assert.ok(out.errors.some((e: any) => e.path === "risk_register"));
});

test("AC-5: the withheld marker is never doubled and falls back to the withheld reason", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const marked = finalizeDecisionOutput(bankAnswer({ linkage: `${WITHHELD_VALUATION_LINKAGE} Discount rate unsourced.` }), withheld());
  assert.equal(marked.output.investment_thesis.expected_return_linkage, `${WITHHELD_VALUATION_LINKAGE} Discount rate unsourced.`);
  const empty = finalizeDecisionOutput(bankAnswer({ linkage: "" }), withheld("No sourced discount rate."));
  assert.equal(empty.output.investment_thesis.expected_return_linkage, `${WITHHELD_VALUATION_LINKAGE} No sourced discount rate.`);
});

test("AC-5/AC-6: a complete valuation without a market price keeps the model linkage and nulls the code-owned returns", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const out = finalizeDecisionOutput(bankAnswer({ acceptedFirst: false }), inputs({ terminalReturns: null, marketPrice: null }));
  assert.equal(out.output.investment_thesis.valuation_accepted_first, true);
  assert.equal(out.output.investment_thesis.expected_return_linkage, "Returns depend on NIM.");
  const m = out.output.expected_return_matrix;
  assert.equal(m.status, "unavailable");
  assert.deepEqual([m.bear_return, m.base_return, m.bull_return, m.probability_weighted_return], [null, null, null, null]);
  assert.deepEqual([m.no_rerating_return, m.weak_stock_outcome, m.permanent_loss_limit], [0.12, -0.1, -0.3]);
});

test("AC-6: weights come from the inputs; missing weights leave the weighted return null", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const m = finalizeDecisionOutput(bankAnswer(), inputs()).output.expected_return_matrix;
  assert.equal(m.probability_weighted_return, 0.32, "0.2*-0.1 + 0.6*0.3 + 0.2*0.8, rounded to 6 decimals");
  assert.equal(m.dilution_omitted, false);
  const noWeights = finalizeDecisionOutput(bankAnswer(), inputs({ probabilities: null })).output.expected_return_matrix;
  assert.equal(noWeights.status, "estimated");
  assert.equal(noWeights.probability_weighted_return, null);
});

test("AC-6/AC-8: returns that don't cover the reported diluted shares are unavailable, not a validation failure", async () => {
  const { finalizeDecisionOutput, decisionOutputFormat } = await finalizeModule();
  const notCovered = inputs({ dilutionCovered: false });
  const m = finalizeDecisionOutput(bankAnswer(), notCovered).output.expected_return_matrix;
  assert.equal(m.status, "unavailable");
  assert.equal(m.bear_return, null);
  assert.equal(m.dilution_omitted, false);
  assert.deepEqual(decisionOutputFormat(notCovered).validate(bankAnswer()), [], "the model cannot fix a code-owned dilution gap, so it is not an error");
});

test("AC-7: finalizing is idempotent and its output still saves", async () => {
  const { finalizeDecisionOutput } = await finalizeModule();
  const raw = bankAnswer({ risks: [riskEntry("Rate cut squeeze", [EV1, FAKE1]), riskEntry("Gap", [EV2], { is_source_gap_only: true })] });
  const first = finalizeDecisionOutput(raw, withheld());
  const second = finalizeDecisionOutput(first.output, withheld());
  assert.deepEqual(second.output, first.output);
  assert.deepEqual(second.gaps, []);
  for (const [type, content] of Object.entries(first.output)) {
    assert.equal(validateArtifactContent(type, content).valid, true, type);
  }
});

test("AC-8: model-facing validation leaves the raw answer untouched for the repair prompt", async () => {
  const { decisionOutputFormat } = await finalizeModule();
  const raw = bankAnswer({ risks: [riskEntry("Rate cut squeeze", [FAKE1, EV1])] });
  const before = JSON.stringify(raw);
  assert.deepEqual(decisionOutputFormat(inputs()).validate(raw), []);
  assert.equal(JSON.stringify(raw), before);
});

test("AC-8: schema errors unrelated to the moved items are still reported", async () => {
  const { decisionOutputFormat } = await finalizeModule();
  const raw: any = bankAnswer();
  raw.risk_register.risks[0].severity = 9;
  const errors = decisionOutputFormat(inputs()).validate(raw);
  assert.ok(errors.length > 0, "an out-of-range severity is still an error");
});
