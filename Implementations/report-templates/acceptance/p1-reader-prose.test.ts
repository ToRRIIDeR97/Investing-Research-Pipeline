// AC-3: code turns leaked identifiers into reader words before validation, so the substance check finds no field names or IDs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readerProse, cleanReaderFields } from "../../../src/lib/research/reporting/reader-prose";
import { checkReportSubstance } from "../../../src/lib/research/reporting/substance";
import { EVIDENCE_ID } from "./fixtures";

test("AC-3: reference tokens and UUIDs are removed from prose", () => {
  assert.equal(readerProse("Revenue grew 22% (ev12) in Q2 2025 [ar3]."), "Revenue grew 22% in Q2 2025.");
  assert.equal(readerProse(`Growth held (see ${EVIDENCE_ID}).`), "Growth held.");
  assert.doesNotMatch(readerProse(`Growth held per record ${EVIDENCE_ID}.`), /[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("AC-3: snake_case identifiers become words with finance acronyms upper case", () => {
  assert.equal(readerProse("The operating_margin median is 35%."), "The operating margin median is 35%.");
  assert.equal(readerProse("fcf_ttm rose to $48.0 billion."), "FCF TTM rose to $48.0 billion.");
  assert.equal(readerProse("revenue_yoy slowed"), "revenue YoY slowed");
});

test("AC-3: ordinary financial text is unchanged", () => {
  for (const text of ["The 10-K for FY2024 shows EV/EBIT of 12.3x.", "S&P 500 beta was 1.2 and Class A shares carry one vote.",
    "Net income was $1,234.5 million, up 4.0% year on year.", "Q3 2025 margin reached 41%."])
    assert.equal(readerProse(text), text);
});

test("AC-3: cleanReaderFields cleans every reader-facing field and leaves ids and coverage alone", () => {
  const section = { id: "business_economics", title: "Segment economics and operating_margin", purpose: "p", coverage: ["business"], artifact_ids: ["a1"],
    paragraphs: [{ kind: "analysis" as const, text: `The capex_to_revenue ratio rose to 20% (ev1, ${EVIDENCE_ID}).`, evidence_ids: [EVIDENCE_ID], artifact_ids: ["a1"] }],
    counterevidence: "fcf_margin stayed at 25%.", implication: "Watch gross_margin.", gaps: ["The dpo series is missing for 2024Q1 (ar2)."], tables: [],
    visuals: [{ kind: "process" as const, title: "How ad_impressions become revenue", caption: "Per the revenue_recognition note.", lanes: [] as any[] }] };
  const cleaned = cleanReaderFields({ section }).section;
  assert.equal(cleaned.id, "business_economics");
  assert.deepEqual(cleaned.coverage, ["business"]);
  assert.deepEqual(cleaned.paragraphs[0].evidence_ids, [EVIDENCE_ID]);
  const findings = checkReportSubstance([cleaned as any]);
  assert.deepEqual(findings.filter(f => /field name|record ID/.test(f.issue)), []);
});

test("AC-3: outline questions and coverage rationales are cleaned", () => {
  const outline = { sections: [], questions: [{ id: "q1", question: "Does fcf_ttm cover buybacks_ttm?", materiality: "material", status: "qualified",
    answer: "Partly (ev3).", evidence_ids: [], artifact_ids: [], follow_up: "Check share_count." }],
    coverage: [{ key: "management", status: "qualified", rationale: "capital_allocation table is thin.", section_ids: [] }] };
  const cleaned = cleanReaderFields({ outline }).outline;
  assert.equal(cleaned.questions[0].question, "Does FCF TTM cover buybacks TTM?");
  assert.equal(cleaned.questions[0].answer, "Partly.");
  assert.doesNotMatch(cleaned.coverage[0].rationale, /_/);
});
