// Independent checks for AC-1..AC-3 (plan author). Different boundaries from the acceptance set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { citationRefs } from "../../../src/lib/research/reporting/refs";
import { readerProse, cleanReaderFields } from "../../../src/lib/research/reporting/reader-prose";
import { artifacts, evidence, EVIDENCE_ID, EVIDENCE_ID_2, ANALYTICS_ID, OPS_ID, RUN_ID } from "../acceptance/fixtures";

const OTHER = "99999999-8888-4777-8666-555555555555";

test("V-AC-1: an id that is neither evidence nor artifact becomes an opaque token that never resolves as a citation", () => {
  const refs = citationRefs(artifacts, evidence);
  const packet = refs.packet({ run_id: RUN_ID, source_id: OTHER, again: OTHER });
  assert.match(packet.run_id, /^id\d+$/);
  assert.equal(packet.source_id, packet.again, "one id, one token");
  assert.notEqual(packet.run_id, packet.source_id);
  const dropped = new Set<string>();
  const resolved = refs.resolve({ paragraphs: [{ evidence_ids: [packet.source_id], artifact_ids: [packet.run_id] }] }, dropped);
  assert.deepEqual(resolved.paragraphs[0].evidence_ids, []);
  assert.deepEqual(resolved.paragraphs[0].artifact_ids, []);
  assert.equal(dropped.size, 2);
});

test("V-AC-1: tokens are stable across packets built from one refs object", () => {
  const refs = citationRefs(artifacts, evidence);
  const a = refs.packet({ x: [EVIDENCE_ID_2, OTHER] });
  const b = refs.packet({ y: { z: OTHER }, w: EVIDENCE_ID_2 });
  assert.equal(a.x[0], b.w);
  assert.equal(a.x[1], b.y.z);
});

test("V-AC-2: tokens resolve case-insensitively, by type, without duplicates", () => {
  const refs = citationRefs(artifacts, evidence);
  const dropped = new Set<string>();
  const out = refs.resolve({ section: { evidence_ids: ["EV1", "ev1", "ar2"], artifact_ids: ["AR2", "ev2", OPS_ID] } }, dropped);
  assert.deepEqual(out.section.evidence_ids, [EVIDENCE_ID]);
  assert.deepEqual(out.section.artifact_ids, [OPS_ID]);
  assert.ok(dropped.has("ar2") && dropped.has("ev2"), "a token of the other type is dropped");
});

test("V-AC-2: a stored id the model echoes stays valid; resolve does not mutate", () => {
  const refs = citationRefs(artifacts, evidence);
  const answer = { evidence_ids: [EVIDENCE_ID], artifact_ids: [ANALYTICS_ID] };
  const out = refs.resolve(answer);
  assert.deepEqual(out, { evidence_ids: [EVIDENCE_ID], artifact_ids: [ANALYTICS_ID] });
  assert.notEqual(out, answer);
});

test("V-AC-1: empty inputs still scrub UUIDs", () => {
  const refs = citationRefs([], []);
  assert.doesNotMatch(JSON.stringify(refs.packet({ a: `x ${EVIDENCE_ID} y` })), /[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("V-AC-3: cleaning is idempotent and tidies punctuation left by removals", () => {
  for (const text of ["Margin rose (ev1; ev2) to 40%.", "Revenue [ar1] grew , driven by ads (ev3).", "fcf_to_net_income was 0.9x."]) {
    const once = readerProse(text);
    assert.equal(readerProse(once), once);
    assert.doesNotMatch(once, /\(\s*[;,]?\s*\)|\[\s*\]|\s{2,}|\s[,.;]/);
  }
  assert.equal(readerProse("Margin rose (ev1; ev2) to 40%."), "Margin rose to 40%.");
});

test("V-AC-3: words that merely resemble tokens are kept (bare upper-case tokens are not stripped outside brackets)", () => {
  for (const text of ["Moody's rates the notes A1 and Baa2.", "The EV12 battery line launched.", "Evidence was thin.", "Arrears rose."])
    assert.equal(readerProse(text), text);
});

test("V-AC-3: a conclusion answer's final coverage rationales are cleaned too", () => {
  const value = { section: { id: "s", title: "t", purpose: "p", coverage: ["conclusion"], artifact_ids: [], paragraphs: [], counterevidence: "c", implication: "i", gaps: [], tables: [] },
    coverage: [{ key: "downside", status: "qualified", rationale: "no_rerating_return is null (ar3).", section_ids: ["s"] }] };
  const cleaned = cleanReaderFields(value);
  assert.equal(cleaned.coverage[0].rationale, "no rerating return is null.");
  assert.equal(cleaned.coverage[0].key, "downside");
});
