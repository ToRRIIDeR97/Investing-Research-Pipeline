import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOutlineStructure, validateProductOutline, type ReportOutline } from "../src/lib/research/reporting/contracts";

const outline = (sections: Array<{ title: string; coverage: string[] }>) => ({ sections }) as unknown as ReportOutline;

test("outline validation reports every violation and names the sections in one error", () => {
  assert.throws(() => validateProductOutline(outline([
    { title: "Summary Judgment", coverage: ["conclusion", "valuation", "downside"] },
    { title: "What Changed in the Reported Record", coverage: ["history", "evidence"] },
    { title: "Valuation and Permanent-Loss Test", coverage: ["valuation", "downside", "forecasts"] },
  ])), (error: Error) => error.message.includes('"What Changed in the Reported Record"')
    && error.message.includes('"Summary Judgment", "Valuation and Permanent-Loss Test"'));
  assert.doesNotThrow(() => validateProductOutline(outline([
    { title: "Summary Judgment", coverage: ["conclusion"] },
    { title: "Origins", coverage: ["history", "business"] },
    { title: "Valuation", coverage: ["valuation", "downside", "forecasts"] },
  ])));
});

test("report drops citations outside the usable inputs and records them for the review, not the reader", async () => {
  const { keepUsableReferences } = await import("../src/lib/research/reporting/runtime");
  const artifacts = [{ id: "a1" }];
  const evidence = [{ id: "e1" }];
  const dropped = new Set<string>();
  const { section } = keepUsableReferences({ section: { artifact_ids: ["a1", "a9"], gaps: [],
    paragraphs: [{ kind: "fact", evidence_ids: ["e1", "e-undated"], artifact_ids: [] }] } }, artifacts, evidence, dropped) as any;
  assert.deepEqual(section.artifact_ids, ["a1"]);
  assert.deepEqual(section.paragraphs[0].evidence_ids, ["e1"]);
  assert.deepEqual(section.gaps, [], "no reader-facing note");
  assert.deepEqual([...dropped].sort(), ["a9", "e-undated"]);
  const { outline } = keepUsableReferences({ outline: { sections: [{ artifact_ids: ["a9"] }],
    questions: [{ evidence_ids: ["e-undated"], artifact_ids: ["a1"] }] } }, artifacts, evidence) as any;
  assert.deepEqual(outline.sections[0].artifact_ids, []);
  assert.deepEqual(outline.questions[0].evidence_ids, []);
});

test("web-fetched SEC filings are dated from their EDGAR filing index", async () => {
  const { secFilingIndexUrl, parseSecFilingDate } = await import("../src/lib/research/sources/role-discovery");
  assert.equal(secFilingIndexUrl("https://www.sec.gov/Archives/edgar/data/1326801/000162828026050705/meta-20260630.htm"),
    "https://www.sec.gov/Archives/edgar/data/1326801/000162828026050705/0001628280-26-050705-index.htm");
  assert.equal(secFilingIndexUrl("https://investor.atmeta.com/news"), null);
  assert.equal(parseSecFilingDate('<div class="infoHead">Filing Date</div>\n  <div class="info">2026-07-30</div>'), "2026-07-30T00:00:00.000Z");
});

test("code repairs the chapter labels that failed the outline in runs 02c8d48b and 81e42ee2", () => {
  const plan = (sections: Array<{ id: string; coverage: string[] }>, coverage: Array<{ key: string; section_ids: string[] }>) =>
    ({ sections: sections.map(s => ({ ...s, title: s.id, purpose: s.id, artifact_ids: [] })),
       coverage: coverage.map(c => ({ ...c, status: "qualified", rationale: "r" })), questions: [] }) as unknown as ReportOutline;
  const fixed = normalizeOutlineStructure(plan([
    { id: "summary", coverage: ["conclusion"] },
    { id: "history", coverage: ["history", "evidence"] },
    { id: "scenarios", coverage: ["forecasts", "valuation"] },
    { id: "valuation", coverage: ["valuation", "downside"] },
  ], [{ key: "business", section_ids: [] }, { key: "valuation", section_ids: ["scenarios", "valuation"] },
      { key: "forecasts", section_ids: ["scenarios"] }, { key: "downside", section_ids: ["valuation"] }]));
  assert.doesNotThrow(() => validateProductOutline(fixed));
  const by = (id: string) => fixed.sections.find(s => s.id === id)!.coverage;
  assert.deepEqual(by("history"), ["history", "evidence", "business"]);
  // The section already covering most of forecasts and downside keeps valuation; ties go to the earlier section.
  assert.deepEqual(by("scenarios"), ["forecasts", "valuation", "downside"]);
  assert.deepEqual(by("valuation"), ["downside"]);
  const check = (key: string) => fixed.coverage.find(c => c.key === key)!.section_ids;
  assert.deepEqual(check("valuation"), ["scenarios"]);
  assert.deepEqual(check("business"), ["history"]);
  assert.deepEqual(check("downside"), ["valuation", "scenarios"]);
  // Valuation only in the opening summary needs real restructuring, so it is left for the model.
  const summaryOnly = normalizeOutlineStructure(plan([{ id: "summary", coverage: ["conclusion", "valuation"] }], [{ key: "valuation", section_ids: ["summary"] }]));
  assert.throws(() => validateProductOutline(summaryOnly));
});
