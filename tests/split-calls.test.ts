// Analysis stages write their artifacts in several smaller calls (handlers/split-calls.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS_COMPETITION_CONTRACT, BUSINESS_FLOW_CONTRACT, BUSINESS_PROCESS_CONTRACT, BUSINESS_SEGMENTS_CONTRACT,
  COMPANY_GENESIS_CONTRACT, GENESIS_HISTORY_CONTRACT, GENESIS_ORIGIN_CONTRACT, MOAT_ASSESSMENT_CONTRACT, MOAT_ATTACK_CONTRACT,
  MOAT_CONTRACT, OPERATING_FORECAST_CONTRACT, OPERATING_MODEL_CONTRACT, OPERATING_RECONCILIATION_CONTRACT,
} from "../src/lib/research/stage-contracts";
import { SEGMENT_RULES } from "../src/lib/research/handlers/business-process-analysis";
import { partCall, scopeRule, type SplitStageInput, type StagePart } from "../src/lib/research/handlers/split-calls";
import { validateSegmentModel } from "../src/lib/research/business/validation";
import { LONG_OUTPUT_STAGES } from "../src/lib/research/model-tiering";

const splits: [string, { requiredKeys: string[] }, { requiredKeys: string[] }[]][] = [
  ["business_process_analysis", BUSINESS_PROCESS_CONTRACT, [BUSINESS_SEGMENTS_CONTRACT, BUSINESS_FLOW_CONTRACT, BUSINESS_COMPETITION_CONTRACT]],
  ["moat_analysis", MOAT_CONTRACT, [MOAT_ASSESSMENT_CONTRACT, MOAT_ATTACK_CONTRACT]],
  ["operating_model", OPERATING_MODEL_CONTRACT, [OPERATING_FORECAST_CONTRACT, OPERATING_RECONCILIATION_CONTRACT]],
  ["company_genesis", COMPANY_GENESIS_CONTRACT, [GENESIS_ORIGIN_CONTRACT, GENESIS_HISTORY_CONTRACT]],
];

for (const [stage, whole, parts] of splits) {
  test(`${stage}: the calls write every stage artifact exactly once`, () => {
    const keys = parts.flatMap((part) => part.requiredKeys);
    assert.deepEqual([...keys].sort(), [...whole.requiredKeys].sort());
    assert.equal(new Set(keys).size, keys.length);
  });
  test(`${stage}: starts at the long output cap`, () => assert.ok(LONG_OUTPUT_STAGES.has(stage)));
}

const first: StagePart = { name: "first", contract: MOAT_ASSESSMENT_CONTRACT, rules: ["First rule."] };
const second: StagePart = { name: "second", contract: MOAT_ATTACK_CONTRACT, rules: ["Second rule."], after: ["first"], extra: { only_second: 1 },
  validate: (value, accepted) => accepted.moat_assessment && value.moat_attack_matrix ? [] : [{ path: "x", message: "needs the assessment" }] };
const input = { sql: null, ctx: null, stageKey: "moat_analysis", taskKey: "moat-analyst:assessment", taskType: "moat_analysis",
  agentName: "asset-analyst", modelTier: "premium", packet: { asset: { symbol: "SOFI" } }, rules: ["Shared rule."], parts: [first, second] } as unknown as SplitStageInput;

test("a part's call has its own task key, contract and packet keys", () => {
  const call = partCall(input, second, { moat_assessment: { a: 1 }, unrelated: true });
  assert.equal(call.taskKey, "moat-analyst:assessment:second");
  assert.equal(call.packet.output_contract, "moat_analysis_second");
  assert.equal(call.packet.only_second, 1);
  assert.deepEqual(call.packet.accepted_artifacts, { moat_assessment: { a: 1 } }, "only the artifacts of the parts it comes after");
  assert.equal(partCall(input, first, {}).packet.accepted_artifacts, undefined);
  assert.equal(partCall(input, first, {}).packet.only_second, undefined);
});

test("the prompt carries the scope rule, the part's rules and the shared rules in that order", () => {
  const prompt = partCall(input, second, {}).promptFactory!({ asset: {} });
  const scope = scopeRule(second, MOAT_ASSESSMENT_CONTRACT.requiredKeys);
  assert.ok(prompt.indexOf(scope) < prompt.indexOf("Second rule.") && prompt.indexOf("Second rule.") < prompt.indexOf("Shared rule."));
  assert.match(scope, /writes only moat_attack_matrix, no_moat_counterfactual/);
  assert.match(scope, /accepted_artifacts/);
  assert.ok(!prompt.includes("First rule."));
});

test("a part's own check runs against the accepted artifacts", () => {
  const format = (accepted: Record<string, unknown>) => partCall(input, { ...second, contract: { requiredKeys: ["moat_attack_matrix"] } }, accepted).outputFormat;
  assert.deepEqual(format({ moat_assessment: {} }).validate!({ moat_attack_matrix: {} }), []);
  assert.equal(format({}).validate!({ moat_attack_matrix: {} }).length, 1);
});

test("normalize runs before the contract check", () => {
  const seen: unknown[] = [];
  const part: StagePart = { name: "n", rules: [], contract: { requiredKeys: ["v"], validate: (value) => { seen.push(value); return []; } },
    normalize: (value) => ({ ...value, fixed: true }) };
  partCall(input, part, {}).outputFormat.validate!({ v: 1 });
  assert.deepEqual(seen, [{ v: 1, fixed: true }]);
});

test("the segment rules name the validator's lender and marketplace triggers", () => {
  const text = SEGMENT_RULES.join("\n");
  for (const word of ["lending", "lender", "credit", "marketplace", "commerce"]) assert.ok(text.includes(`'${word}'`), word);
  assert.match(text, /segment_name is the segment's own name only/);
});

test("a segment named per the rules passes; the e7adabe1 name without lender_details fails", () => {
  const segment = (segment_name: string) => ({
    segment_name, product_or_service: "Third-party loan origination and sale; reported within Financial Services.",
    customer_or_end_user: "Loan buyers", revenue_model: "Fees", contract_structure: "Forward flow", pricing_unit: "Per loan",
    costs_and_reinvestment: "Origination", working_capital_mechanics: "Held briefly", suppliers_or_complements: ["Bank"],
    competitors_or_substitutes: ["Other originators"], regulation: "OCC", revenue_recognition_and_cash_conversion_chain: "On sale",
  });
  const model = (s: Record<string, unknown>) => ({ artifact_type: "segment_model", segments: [s] });
  assert.equal(validateSegmentModel(model(segment("Loan Platform Business"))).valid, true);
  const failing = validateSegmentModel(model(segment("Loan Platform Business (reported within Lending and Financial Services)")));
  assert.ok(failing.errors.some((e) => e.includes("lender_details are missing")));
});
