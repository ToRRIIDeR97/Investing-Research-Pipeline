import assert from "node:assert/strict";
import { test } from "node:test";
import { dropInvalidCitationIds } from "@/lib/research/sources/artifact-evidence";
import { validateArtifactContent } from "@/lib/research/stage-contracts";
import { GENESIS_PROMPT_RULES } from "@/lib/research/handlers/company-genesis";

const known = "00000000-0000-4000-8000-000000000001";
const invented = "00000000-0000-4000-8000-0000000000ff";

const genesis = () => ({
  artifact_type: "company_genesis",
  pre_founding_environment: "Payments were fragmented.", customer_problem: "Merchants lacked online payments.",
  incumbent_failure: "Banks ignored small merchants.", enabling_change: "Broadband adoption.",
  founder_background: "The founder ran a marketplace.",
  founder_motivations: [
    { motivation: "commercial_opportunity", evidence_claim_ids: [known], confidence: 0.8 },
    { motivation: "mission_or_cause", evidence_claim_ids: [invented], confidence: 0.4 },
  ],
  alternative_motivation_interpretations: ["Could be mission-driven."],
  original_product: "Online auctions.", original_customer: "Small merchants.", original_geography: "Argentina",
  original_revenue_model: "Fees.", initial_funding: "Seed round.", early_constraints: "Low card use.", first_proof_point: "Early traction.",
  present_day_implications: ["Marketplace DNA persists."],
  material_claims: [
    { claim: "Supported claim.", evidence_weight: "documented_company_action", evidence_claim_ids: [known, invented], confidence: 0.7 },
    { claim: "Unsupported claim.", evidence_weight: "analyst_inference", evidence_claim_ids: [invented], confidence: 0.3, contradicting_claim_ids: [] },
  ],
});

test("an entry whose only citations were invented is removed, so the artifact still meets its contract", () => {
  const output = { company_genesis: genesis() };
  const dropped = dropInvalidCitationIds(output, [known], { pruneUncited: true });
  assert.deepEqual(dropped, [invented]);
  assert.deepEqual(output.company_genesis.founder_motivations.map((entry) => entry.motivation), ["commercial_opportunity"]);
  assert.deepEqual(output.company_genesis.material_claims.map((entry) => [entry.claim, entry.evidence_claim_ids]), [["Supported claim.", [known]]]);
  assert.equal(validateArtifactContent("company_genesis", output.company_genesis).valid, true);
});

test("without pruning, the emptied entry still fails the contract (other callers keep their behaviour)", () => {
  const output = { company_genesis: genesis() };
  dropInvalidCitationIds(output, [known]);
  assert.equal(output.company_genesis.founder_motivations.length, 2);
  assert.equal(validateArtifactContent("company_genesis", output.company_genesis).valid, false);
});

test("the founder prompt rules ask for a supported motivation, as the validators require", () => {
  const rules = GENESIS_PROMPT_RULES.join("\n");
  assert.doesNotMatch(rules, /use motivation=unknown/);
  assert.match(rules, /at least one entry whose motivation is not unknown/);
  assert.match(rules, /unknown is allowed only for additional entries/);
});
