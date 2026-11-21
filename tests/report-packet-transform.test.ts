// Report packets are tokenized as finished packets, so blocks prepareResearchCall adds late (filing passages, prior
// research) carry tokens too, and are matched to claims by their stored ids before tokenizing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishCallPacket } from "../src/lib/research/run-context";
import { citationRefs } from "../src/lib/research/reporting/refs";

const CLAIM = "11111111-2222-4333-8444-555555555555";
const PASSAGE = "21111111-2222-4333-8444-555555555555";
const SOURCE = "31111111-2222-4333-8444-555555555555";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test("the transform runs last, on every key, including late filing passages", () => {
  const refs = citationRefs([], [{ id: CLAIM }]);
  const packet = { evidence_claims: [{ id: CLAIM, claim_text: "Revenue rose." }], section_plan: { id: "s" },
    filing_passages: [{ passage_id: PASSAGE, source_id: SOURCE, text: "MD&A", claim_ids: [CLAIM] }] };
  const finished = finishCallPacket(packet, ["section_plan"], refs.packet) as any;
  assert.doesNotMatch(JSON.stringify(finished), UUID);
  assert.equal(finished.evidence_claims[0].id, "ev1");
  assert.deepEqual(finished.filing_passages[0].claim_ids, ["ev1"], "a passage's claims carry the same token as the evidence");
  assert.match(finished.filing_passages[0].passage_id, /^id\d+$/);
  assert.equal(Object.keys(finished).at(-1), "section_plan", "per-call keys still come last");
});

test("without a transform the packet is unchanged apart from key order", () => {
  const packet = { b: 1, a: { id: CLAIM } };
  assert.deepEqual(finishCallPacket(packet, ["b"]), { a: { id: CLAIM }, b: 1 });
});
