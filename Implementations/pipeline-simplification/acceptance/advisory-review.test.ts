// Worker-visible acceptance tests for Implementations/pipeline-simplification (AC-2, AC-3, AC-8).
// Run: npx tsx --test Implementations/pipeline-simplification/acceptance/advisory-review.test.ts
// Expectations come from implementation.md, not from the implementation. Don't weaken or skip them.
import test from "node:test";
import assert from "node:assert/strict";
import { DEPTH_CHECKS } from "../../../src/lib/research/reporting/depth";
import { composeDraft, draftDocument, reviewDraftedReport, type CompositionActions, type ReportDraft } from "../../../src/lib/research/reporting/compose";
import { Outline, Section } from "../../../src/lib/research/reporting/contracts";
import { fingerprint } from "../../../src/lib/research/reporting/report";
import { evaluateQualityGates } from "../../../src/lib/workflow/quality-gates";

// ---------- Fixture: a three-chapter draft written by fake actions ----------

const sp = (id: string, coverage: string[]) => ({ id, title: `${id} title`, purpose: "Explain", coverage, artifact_ids: [] as string[] });
const input = { asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["conclusion", "business", "valuation", "downside"] };
const planned = () => ({ sections: [{ ...sp("summary", ["conclusion"]), key_figures: ["FY2024 revenue"] }, { ...sp("a", ["business"]), key_figures: ["FY2024 margin"] },
  { ...sp("b", ["valuation", "downside"]), key_figures: ["FY2024 value"] }], questions: [] as any[], coverage: [
  { key: "conclusion", status: "qualified", rationale: "Planned", section_ids: ["summary"] },
  { key: "business", status: "qualified", rationale: "Planned", section_ids: ["a"] },
  { key: "valuation", status: "qualified", rationale: "Planned", section_ids: ["b"] },
  { key: "downside", status: "qualified", rationale: "Planned", section_ids: ["b"] }] });
const sectionFor = (p: any) => ({ ...p, paragraphs: [{ kind: "analysis", text: `Revenue grew 12% in FY2024 in the ${p.id} view.`, evidence_ids: [], artifact_ids: [] }],
  counterevidence: "Competition.", implication: "Margins hold.", gaps: [], tables: [] });
const finalCoverage = (coverage: any[]) => coverage.map(c => ({ ...c, status: "qualified", rationale: "Written." }));
const met = () => DEPTH_CHECKS.map(c => ({ id: c.id, status: "met" as const, section_id: "", why: "Present." }));
const missing = () => DEPTH_CHECKS.map(c => ({ id: c.id, status: "missing" as const, section_id: "b", why: "Absent." }));
const finding = (section_id: string | undefined, issue: string, category = "writing", severity = "high", extra: Record<string, unknown> = {}) =>
  ({ ...(section_id ? { section_id } : {}), category, severity, issue, repair: "Fix it.", ...extra });

function store() {
  const rows: { id: number; type: string; scope: string; content: any; current: boolean }[] = [];
  const current = (type: string, scope: string) => rows.find(r => r.type === type && r.scope === scope && r.current);
  return {
    rows, current,
    save(type: string, scope: string, value: any) {
      const prior = current(type, scope);
      if (prior && fingerprint(prior.content) === fingerprint(value)) return prior;
      if (prior) prior.current = false;
      const row = { id: rows.length + 1, type, scope, content: structuredClone(value), current: true };
      rows.push(row);
      return row;
    },
    retain(type: string, scopes: string[]) { for (const r of rows) if (r.type === type && r.current && !scopes.includes(r.scope)) r.current = false; },
    byId: (id: number) => rows.find(r => r.id === id)!.content,
  };
}

type Log = { writes: number; reviews: number; reworks: number };
type Verdict = { verdict: string; findings: Record<string, any>[]; depth?: { id: string; status: "met" | "missing" | "partial"; section_id: string; why: string }[] };
function actions(db: ReturnType<typeof store>, log: Log, review: Verdict): CompositionActions {
  return {
    plan: async () => planned() as any,
    write: async (p, _o, _feedback, _c, options) => {
      log.writes++;
      return { ...sectionFor(p), ...(options?.coverage ? { final_coverage: finalCoverage(options.coverage as any) } : {}) } as any;
    },
    review: async () => {
      log.reviews++;
      return { review_summary: "x", quality_score: 0.3, recommendations: [], depth_checks: review.depth ?? met(), review_verdict: review.verdict, findings: review.findings };
    },
    rework: async () => { log.reworks++; return []; },
    save: async (type, scope, value) => db.save(type, scope, value),
    retain: async (type, scopes) => db.retain(type, scopes),
  };
}

async function drafted() {
  const db = store();
  const draftLog: Log = { writes: 0, reviews: 0, reworks: 0 };
  const draft = await composeDraft(input as any, actions(db, draftLog, { verdict: "pass", findings: [] }));
  const ids = { outline: db.current("report_outline", "outline")!.id, sections: draft.sections.map(s => db.current("report_section", s.id)!.id) };
  const reload = (): ReportDraft => draftDocument(input as any, { outline: Outline.parse(db.byId(ids.outline)),
    sections: ids.sections.map(id => Section.parse(db.byId(id))), finalCoverage: draft.finalCoverage });
  return { db, draft, reload, log: { writes: 0, reviews: 0, reworks: 0 } as Log };
}

// ---------- AC-2 / AC-3: one review, no rewrite, no rework ----------

test("AC-2, AC-3: a needs_more_work review with severe, research-gap and rework findings is reviewed once, rewritten never, reworked never", async () => {
  const { db, draft, reload, log } = await drafted();
  const findings = [finding("a", "Thin a.", "writing", "critical"), finding("b", "Valuation broken.", "analysis_rework", "critical", { owner_stage: "asset_valuation" }),
    finding("b", "Missing call report.", "research_gap", "high"), finding(undefined, "General.")];
  const result = await reviewDraftedReport(input as any, actions(db, log, { verdict: "needs_more_work", findings, depth: missing() }), reload());
  assert.equal(log.reviews, 1, "exactly one review call");
  assert.equal(log.writes, 0, "no chapter is rewritten");
  assert.equal(log.reworks, 0, "no post-review rework round");
  assert.equal(result.document.content_hash, draft.document.content_hash, "the returned document is the draft's");
  assert.equal(db.current("report_document", "document")!.content.content_hash, draft.document.content_hash, "the current document is the draft's");
  const reviews = db.rows.filter(r => r.type === "report_review");
  assert.equal(reviews.length, 1, "one report_review saved");
  assert.equal(reviews[0].content.round, 0);
  for (const issue of ["Thin a.", "Valuation broken.", "Missing call report.", "General."])
    assert.ok(reviews[0].content.findings.some((f: any) => f.issue === issue), `finding "${issue}" is kept on the saved review`);
  assert.equal(result.review.review_verdict, "needs_more_work", "the verdict is reported, not hidden");
});

test("AC-2: a failing verdict also gets one review and no rewrite", async () => {
  const { db, draft, reload, log } = await drafted();
  const result = await reviewDraftedReport(input as any, actions(db, log, { verdict: "fail", findings: [finding("summary", "Unsupported buy call.", "evidence", "critical")] }), reload());
  assert.deepEqual(log, { writes: 0, reviews: 1, reworks: 0 });
  assert.equal(result.document.content_hash, draft.document.content_hash);
});

test("AC-2: a passing review with only minor findings is not rewritten either", async () => {
  const { db, draft, reload, log } = await drafted();
  const result = await reviewDraftedReport(input as any, actions(db, log, { verdict: "pass", findings: [finding("a", "Tighten wording.", "writing", "low")] }), reload());
  assert.deepEqual(log, { writes: 0, reviews: 1, reworks: 0 });
  assert.equal(result.document.content_hash, draft.document.content_hash);
});

// ---------- AC-8: the review verdict doesn't block completion; a missing review does ----------

const reviewTask = (verdict: string) => ({ task_type: "ai_review", status: "completed", output_json: { review_verdict: verdict } });
const outcome = (tasks: any[]) => evaluateQualityGates({ run: { run_type: "deep_dive" }, tasks }).missingCoverage;

test("AC-8: a needs_more_work review is a completion warning, not a blocker", () => {
  const item = outcome([reviewTask("needs_more_work")]).find(i => i.key === "ai_review_outcome");
  assert.ok(item, "the verdict is still reported");
  assert.equal(item!.requiredForCompletion, false);
  const result = evaluateQualityGates({ run: { run_type: "deep_dive" }, tasks: [reviewTask("needs_more_work")] });
  assert.ok(result.warnings.some(w => /needs_more_work/.test(w)), "the verdict appears in the warnings");
  assert.ok(!result.errors.some(e => /AI review outcome/.test(e)), "the verdict is not an error");
});

test("AC-8: a failing review is a warning too", () => {
  const item = outcome([reviewTask("fail")]).find(i => i.key === "ai_review_outcome");
  assert.equal(item?.requiredForCompletion, false);
});

test("AC-8: a missing review is still required for completion", () => {
  const item = outcome([]).find(i => i.key === "ai_review_missing");
  assert.ok(item, "a run without a review is reported");
  assert.equal(item!.requiredForCompletion, true);
});
