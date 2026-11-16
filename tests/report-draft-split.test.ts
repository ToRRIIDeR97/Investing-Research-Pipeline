import test from "node:test";
import assert from "node:assert/strict";
import { DEPTH_CHECKS } from "../src/lib/research/reporting/depth";
import { composeDraft, draftDocument, reviewDraftedReport, type CompositionActions, type ReportDraft } from "../src/lib/research/reporting/compose";
import { Outline, Section } from "../src/lib/research/reporting/contracts";
import { createReport, fingerprint } from "../src/lib/research/reporting/report";

// Architecture-9 P4: report_draft writes the draft (composeDraft); ai_reviewer rebuilds it from stored artifacts and
// reviews it (reviewDraftedReport). The expectations below are written out by hand, not derived from the code.

const allMet = () => DEPTH_CHECKS.map(c => ({ id: c.id, status: "met" as const, section_id: "", why: "Present." }));
const plan = (id: string, coverage: string[]) => ({ id, title: `${id} title`, purpose: "Explain", coverage, artifact_ids: [], key_figures: ["FY2024 revenue"] });
const input = { asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["conclusion", "valuation", "downside"] };
const planned = () => ({ sections: [plan("summary", ["conclusion"]), plan("valuation", ["valuation", "downside"])], questions: [] as any[], coverage: [
  { key: "conclusion", status: "qualified", rationale: "Planned", section_ids: ["summary"] },
  { key: "valuation", status: "qualified", rationale: "Planned", section_ids: ["valuation"] },
  { key: "downside", status: "satisfied", rationale: "Planned", section_ids: ["valuation"] }] });
// The research-gap re-plan adds one open question.
const replanned = () => ({ ...planned(), questions: [{ id: "q1", question: "What is the funding mix?", materiality: "supporting", status: "qualified",
  answer: "Not disclosed.", evidence_ids: [], artifact_ids: [], follow_up: "Ask investor relations." }] });
// A figure in every paragraph, so the substance check finds nothing to repair.
const text = (id: string, repaired: boolean) => `Revenue grew ${repaired ? 14 : 12}% in FY2024 in the ${id} view.`;
const section = (p: ReturnType<typeof plan>, repaired: boolean) => ({ ...p, paragraphs: [{ kind: "analysis", text: text(p.id, repaired), evidence_ids: [], artifact_ids: [] }],
  counterevidence: "Competition.", implication: "Margins hold.", gaps: [], tables: [] });
const written = (coverage: ReturnType<typeof planned>["coverage"]) => coverage.map(c => ({ ...c, status: "qualified", rationale: "Written." }));

/** jsonb keeps no key order: a stored value comes back with every object's keys in another order. */
const jsonb = (value: unknown): any => Array.isArray(value) ? value.map(jsonb)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, jsonb((value as any)[key])])) : value;

/** saveReportArtifact's versioning: an unchanged save keeps the current row, a changed one supersedes it. */
function store() {
  const rows: { id: number; type: string; scope: string; content: any; current: boolean }[] = [];
  const current = (type: string, scope: string) => rows.find(r => r.type === type && r.scope === scope && r.current);
  return {
    rows, current,
    save(type: string, scope: string, value: any) {
      const prior = current(type, scope);
      if (prior && fingerprint(prior.content) === fingerprint(value)) return prior;
      if (prior) prior.current = false;
      const row = { id: rows.length + 1, type, scope, content: jsonb(structuredClone(value)), current: true };
      rows.push(row);
      return row;
    },
    retain(type: string, scopes: string[]) { for (const r of rows) if (r.type === type && r.current && !scopes.includes(r.scope)) r.current = false; },
    byId: (id: number) => rows.find(r => r.id === id)!.content,
  };
}

type Scenario = "pass" | "writing" | "research";
function actionsFor(scenario: Scenario, events: string[], db: ReturnType<typeof store>, opts: { failSecondReview?: boolean; firstReviewPasses?: boolean } = {}) {
  let reviews = 0;
  const actions: CompositionActions = {
    plan: async feedback => { events.push(`plan:${feedback.length}`); return (feedback.length ? replanned() : planned()) as any; },
    write: async (p, _outline, feedback, _completed, options) => {
      events.push(`write:${p.id}:${feedback.length ? "repair" : "first"}${options?.coverage ? ":last" : ""}`);
      return { ...section(p as any, feedback.length > 0), ...(options?.coverage ? { final_coverage: written(options.coverage as any) } : {}) } as any;
    },
    review: async document => {
      events.push("review");
      reviews++;
      if (opts.failSecondReview && reviews === 2) throw new Error("Reviewer crashed after the repair");
      const fail = !opts.firstReviewPasses && scenario !== "pass" && reviews === 1;
      return { review_summary: "x", quality_score: 0.5, recommendations: [], depth_checks: allMet(), review_verdict: fail ? "fail" : "pass",
        findings: fail ? [{ section_id: "valuation", category: scenario === "writing" ? "writing" : "research_gap", severity: "high", issue: "Thin.", document_hash: document.content_hash }] : [] };
    },
    rework: async () => { events.push("rework"); return []; },
    save: async (type, scope, value) => { events.push(`save:${type}:${type === "report_review" ? "review" : scope}`); return db.save(type, scope, value); },
    retain: async (type, scopes) => { events.push(`retain:${type}:${scopes.join(",")}`); db.retain(type, scopes); },
  };
  return actions;
}

/** The review stage's view of the draft: artifacts read back by the ids the draft saved, and the stage-row state. */
function reload(db: ReturnType<typeof store>, ids: { outline: number; sections: number[] }, finalCoverage: unknown): ReportDraft {
  const outline = Outline.parse(db.byId(ids.outline));
  const sections = ids.sections.map(id => Section.parse(db.byId(id)));
  return draftDocument(input as any, { outline, sections, finalCoverage: JSON.parse(JSON.stringify(jsonb(finalCoverage))) });
}

/** The document the fixture yields, built by createReport alone. */
function expectedDocument(outline: ReturnType<typeof planned>, repaired: string[]) {
  const sections = outline.sections.map(p => section(p, repaired.includes(p.id)));
  return createReport({ ...input, ...outline, coverage: written(outline.coverage) as any, sections: sections as any });
}

const DRAFT = ["plan:0", "save:report_outline:outline", "save:question_register:questions", "write:valuation:first", "save:report_section:valuation",
  "write:summary:first:last", "save:report_section:summary", "save:report_document:document"];
const REVIEW_START = ["save:report_outline:outline", "save:question_register:questions", "save:report_section:summary", "save:report_section:valuation",
  "retain:report_section:summary,valuation", "save:report_document:document", "review", "save:report_review:review"];
const EXPECTED: Record<Scenario, { review: string[]; repaired: string[]; replanned: boolean }> = {
  pass: { review: REVIEW_START, repaired: [], replanned: false },
  writing: { review: [...REVIEW_START, "rework", "write:valuation:repair", "save:report_section:valuation", "write:summary:repair:last",
    "save:report_section:summary", "retain:report_section:summary,valuation", "save:report_document:document", "review", "save:report_review:review"],
    repaired: ["valuation", "summary"], replanned: false },
  research: { review: [...REVIEW_START, "rework", "plan:1", "save:report_outline:outline", "save:question_register:questions", "write:valuation:repair",
    "save:report_section:valuation", "write:summary:repair:last", "save:report_section:summary", "retain:report_section:summary,valuation",
    "save:report_document:document", "review", "save:report_review:review"], repaired: ["valuation", "summary"], replanned: true },
};

for (const scenario of ["pass", "writing", "research"] as const) {
  test(`report_draft then ai_reviewer: the exact calls and saves when the first review ${scenario === "pass" ? "passes" : `asks for a ${scenario} repair`}`, async () => {
    const events: string[] = [];
    const db = store();
    const draft = await composeDraft(input as any, actionsFor(scenario, events, db));
    assert.deepEqual(events, DRAFT);
    assert.equal(draft.document.content_hash, expectedDocument(planned(), []).content_hash, "the draft is the fixture's document");
    const ids = { outline: db.current("report_outline", "outline")!.id, sections: draft.sections.map(s => db.current("report_section", s.id)!.id) };
    const rows = db.rows.length;

    const rebuilt = reload(db, ids, draft.finalCoverage);
    assert.equal(rebuilt.document.content_hash, draft.document.content_hash, "the draft survives the jsonb round trip");
    events.length = 0;
    const result = await reviewDraftedReport(input as any, actionsFor(scenario, events, db), rebuilt);
    assert.deepEqual(events, EXPECTED[scenario].review);
    if (scenario === "pass") assert.equal(db.rows.length, rows + 1, "re-saving the unchanged draft writes nothing new; only the review is added");
    const expected = expectedDocument(EXPECTED[scenario].replanned ? replanned() : planned(), EXPECTED[scenario].repaired);
    assert.equal(result.document.content_hash, expected.content_hash);
    assert.equal(db.current("report_document", "document")!.content.content_hash, expected.content_hash);
  });
}

test("a retry after a failed repair attempt restores the draft as the current report before its review passes (P4-1)", async () => {
  const db = store();
  const draft = await composeDraft(input as any, actionsFor("writing", [], db));
  const ids = { outline: db.current("report_outline", "outline")!.id, sections: draft.sections.map(s => db.current("report_section", s.id)!.id) };
  const draftRows = { outline: db.current("report_outline", "outline")!.content, sections: draft.sections.map(s => db.current("report_section", s.id)!.content) };

  // Attempt 1 repairs the sections and saves a new document, then crashes in the second review.
  await assert.rejects(reviewDraftedReport(input as any, actionsFor("writing", [], db, { failSecondReview: true }), reload(db, ids, draft.finalCoverage)), /crashed/);
  assert.notEqual(db.current("report_document", "document")!.content.content_hash, draft.document.content_hash, "the failed attempt left its repair current");

  // Attempt 2 reloads the draft by its ids (now superseded rows) and its first review passes.
  const retry = await reviewDraftedReport(input as any, actionsFor("writing", [], db, { firstReviewPasses: true }), reload(db, ids, draft.finalCoverage));
  assert.equal(retry.document.content_hash, draft.document.content_hash);
  const currentDoc = db.current("report_document", "document")!.content;
  assert.equal(currentDoc.content_hash, draft.document.content_hash, "the current document is the draft's");
  assert.equal(fingerprint(db.current("report_outline", "outline")!.content), fingerprint(draftRows.outline), "the current outline is the draft's");
  draft.sections.forEach((s, i) => assert.equal(fingerprint(db.current("report_section", s.id)!.content), fingerprint(draftRows.sections[i]), `section ${s.id} is the draft's`));
  const currentSections = db.rows.filter(r => r.type === "report_section" && r.current).map(r => r.scope).sort();
  assert.deepEqual(currentSections, ["summary", "valuation"]);
  const reviews = db.rows.filter(r => r.type === "report_review" && r.current);
  const latest = reviews.at(-1)!.content;
  assert.equal(latest.report_hash, currentDoc.content_hash, "the saved review describes the current document");
});
