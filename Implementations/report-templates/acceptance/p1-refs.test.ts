// AC-1, AC-2: report model packets carry short reference tokens instead of UUIDs; answers map back to stored ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { citationRefs } from "../../../src/lib/research/reporting/refs";
import { artifacts, evidence, EVIDENCE_ID, EVIDENCE_ID_2, ANALYTICS_ID, VAL_ID, RUN_ID } from "./fixtures";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test("AC-1: a packet carries no UUID anywhere; evidence and artifacts get ev/ar tokens in input order", () => {
  const refs = citationRefs(artifacts, evidence);
  const packet = refs.packet({
    run_id: RUN_ID,
    evidence_claims: evidence.map(e => ({ id: e.id, claim_text: e.claim_text })),
    artifacts: artifacts.map(a => ({ id: a.id, artifact_type: a.artifact_type, content_json: { supporting_claim_ids: [EVIDENCE_ID_2], note: `see ${EVIDENCE_ID}` } })),
  });
  assert.doesNotMatch(JSON.stringify(packet), UUID);
  assert.equal(packet.evidence_claims[0].id, "ev1");
  assert.equal(packet.evidence_claims[1].id, "ev2");
  assert.equal(packet.artifacts[0].id, "ar1");
  assert.equal(packet.artifacts[2].id, "ar3");
  assert.deepEqual(packet.artifacts[0].content_json.supporting_claim_ids, ["ev2"]);
  assert.equal(packet.artifacts[0].content_json.note, "see ev1");
  assert.equal(refs.token(EVIDENCE_ID), "ev1");
  assert.equal(refs.token(VAL_ID), "ar3");
});

test("AC-1: packet() does not mutate its input", () => {
  const refs = citationRefs(artifacts, evidence);
  const input = { evidence_claims: [{ id: EVIDENCE_ID }] };
  refs.packet(input);
  assert.equal(input.evidence_claims[0].id, EVIDENCE_ID);
});

test("AC-2: an answer's evidence_ids and artifact_ids map back to stored ids at any depth", () => {
  const refs = citationRefs(artifacts, evidence);
  const answer = { section: { id: "business", paragraphs: [{ kind: "fact", text: "x", evidence_ids: ["ev2", "ev1"], artifact_ids: ["ar1"] }],
    visuals: [{ kind: "process", lanes: [{ evidence_ids: ["ev1"], artifact_ids: [] }] }] } };
  const resolved = refs.resolve(answer);
  assert.deepEqual(resolved.section.paragraphs[0].evidence_ids, [EVIDENCE_ID_2, EVIDENCE_ID]);
  assert.deepEqual(resolved.section.paragraphs[0].artifact_ids, [ANALYTICS_ID]);
  assert.deepEqual(resolved.section.visuals[0].lanes[0].evidence_ids, [EVIDENCE_ID]);
});

test("AC-2: unknown tokens are dropped and recorded, never stored", () => {
  const refs = citationRefs(artifacts, evidence);
  const dropped = new Set<string>();
  const resolved = refs.resolve({ section: { paragraphs: [{ evidence_ids: ["ev1", "ev99"], artifact_ids: ["ar7"] }] } }, dropped);
  assert.deepEqual(resolved.section.paragraphs[0].evidence_ids, [EVIDENCE_ID]);
  assert.deepEqual(resolved.section.paragraphs[0].artifact_ids, []);
  assert.deepEqual([...dropped].sort(), ["ar7", "ev99"]);
});
