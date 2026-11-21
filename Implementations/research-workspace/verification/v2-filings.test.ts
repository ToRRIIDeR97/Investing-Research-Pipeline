// Independent checks for P2 (F-1 to F-4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compressFiling, filingForm, filingText, recentFilings, sectionText } from "../../../src/lib/research/filings/library";

const doc = (id: string, over: Record<string, unknown>) => ({ id, source_type: "regulatory_filing", title: "x", url: `https://www.sec.gov/${id}.htm`,
  published_at: "2026-05-01T00:00:00.000Z", retrieved_at: "2026-06-01T00:00:00.000Z", metadata_json: {}, ...over });

test("V-F1: amendments map to their form; lookalikes do not", () => {
  assert.equal(filingForm(doc("a", { title: "Form 10-K/A amendment" })), "10-K");
  assert.equal(filingForm(doc("b", { title: "Form 20-F 2025" })), "20-F");
  assert.equal(filingForm(doc("c", { title: "110-KV transformer order" })), null);
  assert.equal(filingForm(doc("d", { metadata_json: { form: "DEF 14A" }, title: "Proxy" })), null);
});

test("V-F2: the window boundary and an empty list", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  assert.deepEqual(recentFilings([], now), []);
  const edge = recentFilings([doc("in", { title: "10-Q", published_at: "2024-11-22T00:00:00.000Z" }), doc("out", { title: "10-Q", published_at: "2024-11-20T00:00:00.000Z" })], now);
  assert.deepEqual(edge.map((d) => d.id), ["in"]);
  assert.equal(recentFilings([doc("k", { title: "10-K" })], now, 0.1).length, 0, "a shorter window");
});

test("V-F3: no chunks, one short section, repeated titles apart stay apart", () => {
  assert.deepEqual(compressFiling([]), { sections: [], total_chars: 0, preview_chars: 0 });
  const short = compressFiling([{ chunk_index: 0, section_title: "Item 1", text: "Short." }]);
  assert.equal(short.sections[0].preview, "Short.");
  const split = compressFiling([{ chunk_index: 0, section_title: "Notes", text: "a" }, { chunk_index: 1, section_title: "MD&A", text: "b" }, { chunk_index: 2, section_title: "Notes", text: "c" }]);
  assert.deepEqual(split.sections.map((s) => s.title), ["Notes", "MD&A", "Notes"]);
  assert.equal(sectionText([{ chunk_index: 0, section_title: "A", text: "x" }], -1), null);
});

test("V-F4: script and style content never reaches the text download", () => {
  const text = filingText("T", [{ chunk_index: 0, section_title: "A", text: "Keep <b>this</b><script>alert(1)</script> text" }]);
  assert.match(text, /Keep this/);
  assert.doesNotMatch(text, /[<>]/);
});
