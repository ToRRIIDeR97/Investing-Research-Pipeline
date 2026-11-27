// The AI review packet keeps what the report cites (reporting/packet.ts), and the call log keeps the end of an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { citedIds, fitPacket, REPORT_PACKET_BYTES, REVIEW_PACKET_BYTES } from "../src/lib/research/reporting/packet";
import { responseExcerpt } from "../src/lib/agent-harness/runner";

const blob = (kb: number) => "x".repeat(kb * 1024);
const artifact = (id: string, kb: number) => ({ id, artifact_type: `type_${id}`, content_json: { body: blob(kb) } });
const claim = (id: string) => ({ id, claim: `Claim ${id} about SoFi deposits.`, quote: blob(1) });

test("citedIds collects artifact and evidence ids from every level of a document", () => {
  const ids = citedIds({ sections: [{ artifact_ids: ["a1"], paragraphs: [{ evidence_ids: ["e1"], artifact_ids: ["a2"] }],
    key_reasons: [{ evidence_ids: ["e2"] }] }], questions: [{ evidence_ids: ["e3"], artifact_ids: [] }] });
  assert.deepEqual([...ids.artifactIds].sort(), ["a1", "a2"]);
  assert.deepEqual([...ids.evidenceIds].sort(), ["e1", "e2", "e3"]);
});

test("with keep, uncited artifacts go before cited ones and every cited claim stays", () => {
  const cited = Array.from({ length: 50 }, (_, i) => claim(`c${i}`));
  const packet = { artifacts: [artifact("cited", 30), artifact("big-uncited", 90), artifact("uncited", 40)], evidence_claims: cited };
  const keep = { artifactIds: new Set(["cited"]), evidenceIds: new Set(cited.map(c => c.id)) };
  const fitted: any = fitPacket(packet, 100 * 1024, "evidence_claims", keep);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 100 * 1024);
  assert.deepEqual(fitted.artifacts.map((a: any) => a.id), ["cited"]);
  assert.deepEqual(fitted.omitted_artifacts.sort(), ["type_big-uncited", "type_uncited"]);
  assert.equal(fitted.evidence_claims.length, 50, "no cited claim is cut while an artifact can go");
});

test("with keep, a cited artifact is dropped before any cited claim", () => {
  const cited = Array.from({ length: 60 }, (_, i) => claim(`c${i}`));
  // Eight 1 KB fields each, so capping at 2 KB per field leaves them whole; the budget holds the claims and no artifact.
  const wide = (id: string) => ({ id, artifact_type: `type_${id}`, content_json: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, blob(1)])) });
  const packet = { artifacts: [wide("a"), wide("b")], evidence_claims: cited };
  const budget = Buffer.byteLength(JSON.stringify({ ...packet, evidence_claims: cited.map(({ quote: _, ...c }) => c), artifacts: [] })) + 200; // eslint-disable-line @typescript-eslint/no-unused-vars
  const fitted: any = fitPacket(packet, budget, "evidence_claims", { artifactIds: new Set(["a", "b"]), evidenceIds: new Set(cited.map(c => c.id)) });
  assert.equal(fitted.evidence_claims.length, 60);
  assert.equal(fitted.artifacts.length, 0);
  assert.deepEqual(fitted.omitted_artifacts.sort(), ["type_a", "type_b"]);
});

test("without keep, fitPacket behaves as before: claims are halved before artifacts are dropped", () => {
  const claims = Array.from({ length: 200 }, (_, i) => claim(`c${i}`));
  const fitted: any = fitPacket({ artifacts: [artifact("a", 1)], evidence_claims: claims }, 5 * 1024);
  assert.ok(fitted.evidence_claims.length < 200);
  assert.equal(fitted.artifacts.length, 1);
});

test("the review budget is larger than the section budget and leaves room under 100K tokens", () => {
  assert.ok(REVIEW_PACKET_BYTES > REPORT_PACKET_BYTES);
  assert.ok(REVIEW_PACKET_BYTES * 0.45 < 85_000, "about 0.41 tokens per byte measured, plus rules");
});

test("a long answer's excerpt keeps its start and its end", () => {
  const text = `{"start":1,${"a".repeat(30_000)}"end":2}`;
  const excerpt = responseExcerpt(text);
  assert.ok(excerpt.startsWith('{"start":1'));
  assert.ok(excerpt.endsWith('"end":2}'));
  assert.match(excerpt, /characters omitted/);
  assert.equal(responseExcerpt("short"), "short");
});
