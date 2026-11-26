// Worker-visible acceptance tests for Implementations/report-review-resilience (AC-1 .. AC-5).
// Run: npx tsx --test Implementations/report-review-resilience/acceptance/*.test.ts
// Expectations are written from the plan, not from the implementation. Do not weaken or skip them.
import test from "node:test";
import assert from "node:assert/strict";
import { DEPTH_CHECKS } from "../../../src/lib/research/reporting/depth";
import { composeDraft, draftDocument, reviewDraftedReport, type CompositionActions, type ReportDraft } from "../../../src/lib/research/reporting/compose";
import * as contracts from "../../../src/lib/research/reporting/contracts";
import { Outline, Section, normalizeOutlineStructure, validateProductOutline, validateChartPlan, type ReportOutline, type ReportSection } from "../../../src/lib/research/reporting/contracts";
import { fingerprint } from "../../../src/lib/research/reporting/report";
import { ResearchAgentRunError } from "../../../src/lib/agent-harness/errors";

// ---------- AC-1: the outline normaliser never leaves a standalone history/evidence chapter ----------

const sp = (id: string, coverage: string[]) => ({ id, title: `${id} title`, purpose: "Explain", coverage, artifact_ids: [] as string[] });
const outlineOf = (sections: ReturnType<typeof sp>[], coverage: { key: string; section_ids: string[] }[]): ReportOutline =>
  ({ sections, questions: [], coverage: coverage.map(c => ({ ...c, status: "qualified" as const, rationale: "Planned" })) });

test("AC-1: a section listing history and valuation loses valuation and still validates (SoFi 3c3fc4ce outline)", () => {
  const fixed = normalizeOutlineStructure(outlineOf(
    [sp("summary", ["conclusion"]), sp("gaap", ["history", "valuation"]), sp("val", ["valuation", "forecasts", "downside"])],
    [{ key: "conclusion", section_ids: ["summary"] }, { key: "history", section_ids: ["gaap"] }, { key: "business", section_ids: [] },
      { key: "valuation", section_ids: ["gaap", "val"] }, { key: "forecasts", section_ids: ["val"] }, { key: "downside", section_ids: ["val"] }]));
  assert.doesNotThrow(() => validateProductOutline(fixed));
  const gaap = fixed.sections.find(s => s.id === "gaap")!;
  assert.ok(!gaap.coverage.includes("valuation"), "valuation stays only on the valuation chapter");
  assert.ok(gaap.coverage.some(k => k !== "history" && k !== "evidence"), "the history chapter gains a company coverage key");
  for (const key of gaap.coverage) {
    const check = fixed.coverage.find(c => c.key === key);
    if (check) assert.ok(check.section_ids.includes("gaap"), `coverage map lists gaap under ${key}`);
  }
  assert.deepEqual(fixed.coverage.find(c => c.key === "valuation")!.section_ids, ["val"]);
});

// ---------- AC-2: a planned chart that was not drawn becomes a reader-facing gap in code ----------

const written = (over: Partial<ReportSection> = {}): ReportSection => ({ id: "history", title: "History", purpose: "p", coverage: ["history", "business"],
  artifact_ids: ["hr"], paragraphs: [{ kind: "analysis", text: "Margins widened.", evidence_ids: [], artifact_ids: ["hr"] }],
  counterevidence: "c", implication: "i", gaps: [], tables: [], ...over });
const CHART = "Net interest margin trend (ratio) from historical_record series net_interest_margin_percent";

test("AC-2: fillChartPlanGap adds one plain gap when the planned chart is missing, so validateChartPlan passes", () => {
  const fill = (contracts as any).fillChartPlanGap as (plan: { chart_plan?: string }, section: ReportSection) => ReportSection;
  assert.equal(typeof fill, "function", "contracts exports fillChartPlanGap");
  const section = written();
  assert.throws(() => validateChartPlan({ chart_plan: CHART }, section), /plans a chart/);
  const filled = fill({ chart_plan: CHART }, section);
  assert.equal(filled.gaps.length, 1);
  assert.match(filled.gaps[0], /\bchart\b/i);
  assert.doesNotThrow(() => validateChartPlan({ chart_plan: CHART }, filled));
  assert.deepEqual(section.gaps, [], "the input section is not mutated");
  assert.deepEqual(fill({}, section), section, "no chart planned: unchanged");
  const explained = written({ gaps: ["The margin chart is omitted because only four quarters are reported."] });
  assert.deepEqual(fill({ chart_plan: CHART }, explained), explained, "a gap that already explains the chart: unchanged");
});

// ---------- Shared review fixture (AC-3 .. AC-5) ----------

const allMet = () => DEPTH_CHECKS.map(c => ({ id: c.id, status: "met" as const, section_id: "", why: "Present." }));
const input = { asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["conclusion", "business", "valuation", "downside"] };
const planned = () => ({ sections: [{ ...sp("summary", ["conclusion"]), key_figures: ["FY2024 revenue"] }, { ...sp("a", ["business"]), key_figures: ["FY2024 margin"] },
  { ...sp("b", ["valuation", "downside"]), key_figures: ["FY2024 value"] }], questions: [] as any[], coverage: [
  { key: "conclusion", status: "qualified", rationale: "Planned", section_ids: ["summary"] },
  { key: "business", status: "qualified", rationale: "Planned", section_ids: ["a"] },
  { key: "valuation", status: "qualified", rationale: "Planned", section_ids: ["b"] },
  { key: "downside", status: "qualified", rationale: "Planned", section_ids: ["b"] }] });
const sectionFor = (p: any, repaired: boolean) => ({ ...p, paragraphs: [{ kind: "analysis", text: `Revenue grew ${repaired ? 14 : 12}% in FY2024 in the ${p.id} view.`, evidence_ids: [], artifact_ids: [] }],
  counterevidence: "Competition.", implication: "Margins hold.", gaps: [], tables: [] });
const finalCoverage = (coverage: any[]) => coverage.map(c => ({ ...c, status: "qualified", rationale: "Written." }));

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

const finding = (section_id: string | undefined, issue: string, category = "writing") =>
  ({ ...(section_id ? { section_id } : {}), category, severity: "high", issue, repair: "Fix it." });

interface Opts { findings?: Record<string, any>[]; failWrite?: (id: string, feedback: any[]) => Error | undefined; failReview?: Error }
function actions(db: ReturnType<typeof store>, log: { writes: { id: string; issues: string[] }[]; reviews: number }, opts: Opts = {}): CompositionActions {
  return {
    plan: async feedback => (feedback.length ? { ...planned(), questions: [] } : planned()) as any,
    write: async (p, _o, feedback, _c, options) => {
      if (feedback.length) log.writes.push({ id: p.id, issues: feedback.map(f => String(f.issue)).sort() });
      const err = feedback.length ? opts.failWrite?.(p.id, feedback) : undefined;
      if (err) throw err;
      return { ...sectionFor(p, feedback.length > 0), ...(options?.coverage ? { final_coverage: finalCoverage(options.coverage as any) } : {}) } as any;
    },
    review: async () => {
      log.reviews++;
      if (opts.failReview) throw opts.failReview;
      const first = log.reviews === 1;
      return { review_summary: "x", quality_score: 0.5, recommendations: [], depth_checks: allMet(), review_verdict: first ? "fail" : "pass",
        findings: first ? (opts.findings ?? [finding("a", "Thin a.")]) : [] };
    },
    rework: async () => [],
    save: async (type, scope, value) => db.save(type, scope, value),
    retain: async (type, scopes) => db.retain(type, scopes),
  };
}

async function drafted() {
  const db = store();
  const log = { writes: [] as { id: string; issues: string[] }[], reviews: 0 };
  const draft = await composeDraft(input as any, actions(db, log));
  const ids = { outline: db.current("report_outline", "outline")!.id, sections: draft.sections.map(s => db.current("report_section", s.id)!.id) };
  const reload = (): ReportDraft => draftDocument(input as any, { outline: Outline.parse(db.byId(ids.outline)),
    sections: ids.sections.map(id => Section.parse(db.byId(id))), finalCoverage: draft.finalCoverage });
  const draftContent = { outline: db.current("report_outline", "outline")!.content, sections: Object.fromEntries(draft.sections.map(s => [s.id, db.current("report_section", s.id)!.content])) };
  return { db, draft, reload, draftContent, log: { writes: [] as { id: string; issues: string[] }[], reviews: 0 } };
}

const contentFailure = (type = "schema_validation") => new ResearchAgentRunError(
  "Agent attempts exhausted: Structured output validation failed: report: Error: section_plan.chart_plan plans a chart", {} as any, { error_type: type });

// ---------- AC-3: a failing review keeps the draft and completes the review ----------
// pipeline-simplification: there is no repair round, so no rewrite can fail. A failing review keeps the draft and saves the
// round-0 review with its findings open and no repair marker (was: a rewrite's content failure restored the draft and
// marked the review repair failed).

test("AC-3 (pipeline-simplification): a failing review keeps the draft and saves the round-0 review with its findings, no rewrite", async () => {
  const { db, draft, reload, draftContent, log } = await drafted();
  const result = await reviewDraftedReport(input as any, actions(db, log, { findings: [finding("a", "Thin a."), finding("b", "Thin b.")],
    failWrite: id => id === "a" ? contentFailure() : undefined }), reload());
  assert.equal(result.document.content_hash, draft.document.content_hash, "the returned document is the draft's");
  assert.equal((result.review as any).repair, undefined, "pipeline-simplification: no repair ran, so none is marked failed");
  assert.deepEqual(log.writes, [], "pipeline-simplification: no section is rewritten");
  assert.equal(log.reviews, 1, "no second review runs");
  assert.equal(db.current("report_document", "document")!.content.content_hash, draft.document.content_hash, "current document is the draft's");
  assert.equal(fingerprint(db.current("report_outline", "outline")!.content), fingerprint(draftContent.outline), "current outline is the draft's");
  for (const [id, content] of Object.entries(draftContent.sections))
    assert.equal(fingerprint(db.current("report_section", id)!.content), fingerprint(content), `current section ${id} is the draft's, even if its rewrite was saved`);
  const reviews = db.rows.filter(r => r.type === "report_review" && r.current);
  const latest = reviews.at(-1)!.content;
  assert.equal(latest.report_hash, draft.document.content_hash, "the saved review describes the current document");
  assert.equal(latest.repair, undefined, "pipeline-simplification: no repair marker (was status failed)");
  assert.equal(latest.round, 0);
  assert.ok(latest.findings.some((f: any) => f.issue === "Thin a."), "the reviewer's findings stay open on the saved review");
});

test("AC-3 (pipeline-simplification): no conclusion rewrite runs either", async () => {
  const { db, draft, reload, log } = await drafted();
  const result = await reviewDraftedReport(input as any, actions(db, log, { failWrite: id => id === "summary" ? contentFailure("output_exhausted") : undefined }), reload());
  assert.equal(result.document.content_hash, draft.document.content_hash);
  assert.equal((result.review as any).repair, undefined, "pipeline-simplification: no conclusion rewrite runs (was repair status failed)");
  assert.deepEqual(log.writes, [], "pipeline-simplification: no section is rewritten");
});

// ---------- AC-4: every other failure still fails the stage as before ----------
// pipeline-simplification: the repair round is gone, so these now check the review call itself: its errors are rethrown
// unchanged and the stage's own retry handles them (was: errors from a repair-round rewrite).

test("AC-4 (pipeline-simplification): a transient provider failure in the review call is rethrown unchanged", async () => {
  const { db, reload, log } = await drafted();
  const transient = new ResearchAgentRunError("Agent attempts exhausted: overloaded", {} as any, { error_type: "server_error" });
  await assert.rejects(reviewDraftedReport(input as any, actions(db, log, { failReview: transient }), reload()), e => e === transient);
});

test("AC-4 (pipeline-simplification): a code error in the review call is rethrown unchanged", async () => {
  const { db, reload, log } = await drafted();
  const bug = new TypeError("Cannot read properties of undefined");
  await assert.rejects(reviewDraftedReport(input as any, actions(db, log, { failReview: bug }), reload()), e => e === bug);
});

// ---------- AC-5: each body section's repair sees only its own findings and report-wide ones ----------
// pipeline-simplification: no section is rewritten, so no section receives findings as feedback; they all stay on the
// saved review (was: a and b rewritten with their own and report-wide findings, the summary with all of them).

test("AC-5 (pipeline-simplification): no section is rewritten; every finding stays on the review", async () => {
  const { db, reload, log } = await drafted();
  const result = await reviewDraftedReport(input as any, actions(db, log, { findings: [finding("a", "Thin a."), finding("b", "Thin b."), finding(undefined, "General.")] }), reload());
  assert.deepEqual(log.writes, [], "pipeline-simplification: no rewrites");
  assert.deepEqual(result.review.findings.map(f => f.issue).filter(Boolean).sort(), ["General.", "Thin a.", "Thin b."]);
});
