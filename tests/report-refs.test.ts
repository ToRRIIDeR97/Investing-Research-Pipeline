import { test } from "node:test";
import assert from "node:assert/strict";
import { citationRefs } from "../src/lib/research/reporting/refs";
import { readerProse } from "../src/lib/research/reporting/reader-prose";

const EV = "6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const AR = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

test("other UUIDs get one stable id token per refs object, also in object keys", () => {
  const refs = citationRefs([{ id: AR }], [{ id: EV }]);
  const first = refs.packet({ run_id: OTHER, [OTHER]: 1 });
  const second = refs.packet({ again: OTHER.toUpperCase() });
  assert.deepEqual(first, { run_id: "id1", id1: 1 });
  assert.deepEqual(second, { again: "id1" });
  assert.equal(refs.token(OTHER), "id1");
});

test("resolve accepts any-case tokens and stored ids, removes duplicates, drops wrong-type refs", () => {
  const refs = citationRefs([{ id: AR }], [{ id: EV }]);
  const dropped = new Set<string>();
  const out = refs.resolve({ evidence_ids: ["EV1", EV, "ar1"], artifact_ids: ["Ar1", "ev1", "id1"] }, dropped);
  assert.deepEqual(out, { evidence_ids: [EV], artifact_ids: [AR] });
  assert.deepEqual([...dropped].sort(), ["ar1", "ev1", "id1"]);
});

test("resolve maps a table's artifact_id token back to the stored id", () => {
  const refs = citationRefs([{ id: AR }], [{ id: EV }]);
  const out = refs.resolve({ section: { tables: [{ title: "t", artifact_id: "ar1", path: "quarterly" }, { artifact_id: "ar9" }] } });
  assert.equal(out.section.tables[0].artifact_id, AR);
  assert.equal(out.section.tables[1].artifact_id, "ar9");
});

test("readerProse is idempotent and keeps bracketed text that is not a reference", () => {
  for (const text of ["Revenue grew 22% (ev12, Q2 2025) on capex_to_da of 2.1x.", "Margins held (A1 shares) and EV12 is a label."]) {
    const once = readerProse(text);
    assert.equal(readerProse(once), once);
  }
  assert.equal(readerProse("Revenue grew 22% (ev12, Q2 2025) on capex_to_da of 2.1x."), "Revenue grew 22% (Q2 2025) on capex to D&A of 2.1x.");
  assert.equal(readerProse("Margins held (A1 shares) and EV12 is a label."), "Margins held (A1 shares) and EV12 is a label.");
});
