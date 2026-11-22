// F-1 to F-4: which filings the library lists, and how a filing is compressed into an outline and plain text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FILING_FORMS, compressFiling, filingForm, filingText, recentFilings, sectionText } from "../../../src/lib/research/filings/library";

const doc = (id: string, over: Record<string, unknown>) => ({ id, source_type: "regulatory_filing", title: "Filing", url: `https://www.sec.gov/${id}.htm`,
  published_at: "2026-05-01T00:00:00.000Z", retrieved_at: "2026-06-01T00:00:00.000Z", metadata_json: {}, ...over });

test("F-1: the form comes from metadata, then the title or URL", () => {
  assert.deepEqual(FILING_FORMS, ["10-K", "10-Q", "20-F", "40-F", "6-K", "8-K"]);
  assert.equal(filingForm(doc("a", { metadata_json: { form: "10-Q" } })), "10-Q");
  assert.equal(filingForm(doc("b", { title: "SoFi Technologies 10-K 2025" })), "10-K");
  assert.equal(filingForm(doc("c", { title: "Annual report", url: "https://www.sec.gov/Archives/edgar/data/1/x/sofi-10-k-2025.htm" })), "10-K");
  assert.equal(filingForm(doc("d", { title: "Investor day slides", url: "https://ir.example.com/deck.pdf" })), null);
});

test("F-2: two years of primary filings, one per URL, newest first", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const docs = [
    doc("q3", { title: "10-Q Q3 2026", published_at: "2026-11-01T00:00:00.000Z" }),
    doc("k25", { title: "10-K 2025", published_at: "2026-02-20T00:00:00.000Z" }),
    doc("old", { title: "10-K 2023", published_at: "2024-02-20T00:00:00.000Z" }),
    doc("undated", { title: "10-Q", published_at: null }),
    doc("deck", { title: "Investor deck", url: "https://ir.example.com/deck.pdf", published_at: "2026-10-01T00:00:00.000Z" }),
    doc("dup1", { title: "8-K earnings", url: "https://www.sec.gov/e.htm", published_at: "2026-07-30T00:00:00.000Z", retrieved_at: "2026-08-01T00:00:00.000Z" }),
    doc("dup2", { title: "8-K earnings", url: "https://www.sec.gov/e.htm", published_at: "2026-07-30T00:00:00.000Z", retrieved_at: "2026-09-01T00:00:00.000Z" }),
  ];
  const listed = recentFilings(docs, now);
  assert.deepEqual(listed.map(d => d.id), ["q3", "dup2", "k25"]);
  assert.deepEqual(listed.map(d => d.form), ["10-Q", "8-K", "10-K"]);
});

const chunks = [
  { chunk_index: 2, section_title: "Risk Factors", text: "Credit losses may rise.\n\n  Funding costs may rise." },
  { chunk_index: 0, section_title: "Business", text: "We run a digital bank." },
  { chunk_index: 1, section_title: "Business", text: "Members use lending, deposits and investing products. ".repeat(20) },
  { chunk_index: 3, section_title: null, text: "<p>Exhibit index</p>" },
];

test("F-3: an outline of sections with sizes and short previews; a section's full text on demand", () => {
  const filing = compressFiling(chunks, 60);
  assert.deepEqual(filing.sections.map(s => s.title), ["Business", "Risk Factors", "Section 3"]);
  assert.deepEqual(filing.sections.map(s => s.index), [0, 1, 2]);
  const business = filing.sections[0];
  assert.ok(business.preview.length <= 61 && business.preview.endsWith("…"));
  assert.doesNotMatch(business.preview, /\s{2,}/);
  assert.ok(business.chars > business.preview.length);
  assert.equal(filing.total_chars, filing.sections.reduce((n, s) => n + s.chars, 0));
  assert.equal(sectionText(chunks, 1), "Credit losses may rise. Funding costs may rise.");
  assert.equal(sectionText(chunks, 9), null);
});

test("F-4: the text download is plain text with headings and no HTML", () => {
  const text = filingText("SoFi 10-K 2025", chunks);
  assert.match(text, /^# SoFi 10-K 2025\n/);
  assert.match(text, /\n## Business\n/);
  assert.match(text, /\n## Risk Factors\n/);
  assert.doesNotMatch(text, /<[a-z/][^>]*>/i);
  assert.match(text, /Exhibit index/);
});
