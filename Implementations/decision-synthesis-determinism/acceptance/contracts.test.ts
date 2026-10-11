import test from "node:test";
import assert from "node:assert/strict";
import { INVENTED, catalyst, completeInputs, loadFinalize, rawDecision, risk, withheldInputs } from "./fixtures";
import { validateArtifactContent } from "../../../src/lib/research/stage-contracts";
import { validateCatalystRegister, validateRiskRegister } from "../../../src/lib/research/decision/validation";
import { generateMarkdownReport } from "../../../src/lib/export/report-generator";

test("AC-7: every finalized artifact passes the save-time schema, including withheld nulls", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  const raw = rawDecision({
    catalyst_register: { artifact_type: "catalyst_register", catalysts: [catalyst("Q3 2026 earnings release"), catalyst("Ad pricing", { is_business_driver_only: true })] },
  });
  for (const inputs of [completeInputs(), withheldInputs()]) {
    const { output } = finalizeDecisionOutput(raw, inputs);
    for (const [type, content] of Object.entries(output)) {
      const result = validateArtifactContent(type, content);
      assert.equal(result.valid, true, `${type} (${inputs.valuation.status}): ${result.errors.join("; ")}`);
    }
  }
});

test("AC-7: flagged items still fail save-time validation if they ever reach it", () => {
  assert.equal(validateRiskRegister({ artifact_type: "risk_register", risks: [risk("Gap", { is_source_gap_only: true })] }).valid, false);
  assert.equal(validateCatalystRegister({ artifact_type: "catalyst_register", catalysts: [catalyst("Driver", { is_business_driver_only: true })] }).valid, false);
});

test("AC-8: the model-facing format accepts flagged items, invented citations and a wrong thesis flag", async () => {
  const { decisionOutputFormat } = await loadFinalize();
  const raw = rawDecision({
    risk_register: { artifact_type: "risk_register", risks: [
      risk("Capex-driven compression of free cash flow", { supporting_claim_ids: [INVENTED, "11111111-1111-4111-8111-111111111111"] }),
      risk("Unverified market price", { is_source_gap_only: true }),
    ] },
    catalyst_register: { artifact_type: "catalyst_register", catalysts: [catalyst("Q3 2026 earnings release"), catalyst("Ad pricing", { is_business_driver_only: true })] },
  });
  raw.investment_thesis.valuation_accepted_first = true;
  const format = decisionOutputFormat(withheldInputs());
  assert.deepEqual(format.requiredKeys.slice().sort(), Object.keys(raw).sort());
  assert.deepEqual(format.validate(raw), []);
});

test("AC-8: the model-facing format still rejects an answer that leaves a register empty", async () => {
  const { decisionOutputFormat } = await loadFinalize();
  const raw = rawDecision({
    catalyst_register: { artifact_type: "catalyst_register", catalysts: [catalyst("Ad pricing", { is_business_driver_only: true })] },
  });
  const errors = decisionOutputFormat(completeInputs()).validate(raw);
  assert.ok(errors.some((e: any) => e.path === "catalyst_register"), JSON.stringify(errors));
});

test("AC-9: the exported report never prints placeholder returns", async () => {
  const { finalizeDecisionOutput } = await loadFinalize();
  // Valuation complete but no market price, so no returns can be computed.
  const { output } = finalizeDecisionOutput(rawDecision(), { ...completeInputs(), terminalReturns: null, marketPrice: null });
  assert.equal(output.expected_return_matrix.status, "unavailable");
  const report = generateMarkdownReport({
    asset: { canonical_name: "Example", slug: "example", asset_kind: "equity" },
    decision: output,
  } as any);
  const section = report.slice(report.indexOf("Expected-return matrix"));
  assert.ok(!/null%|NaN%|undefined%|\b0%/.test(section.slice(0, 400)), section.slice(0, 400));
  assert.match(section, /Not available/);
});
