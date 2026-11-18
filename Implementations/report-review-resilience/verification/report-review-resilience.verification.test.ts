// Plan-author verification tests for Implementations/report-review-resilience. Same contract as acceptance/,
// different cases and sequences. Written by the same author as the plan and the acceptance set: not independent.
// Run: npx tsx --test Implementations/report-review-resilience/verification/*.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { DEPTH_CHECKS } from "../../../src/lib/research/reporting/depth";
import { composeDraft, draftDocument, reviewDraftedReport, type CompositionActions } from "../../../src/lib/research/reporting/compose";
import * as contracts from "../../../src/lib/research/reporting/contracts";
import { Outline, Section, normalizeOutlineStructure, validateProductOutline, validateChartPlan, type ReportOutline, type ReportSection } from "../../../src/lib/research/reporting/contracts";
import { fingerprint } from "../../../src/lib/research/reporting/report";
import { ResearchAgentRunError } from "../../../src/lib/agent-harness/errors";

const sp = (id: string, coverage: string[]) => ({ id, title: `${id} title`, purpose: "Explain", coverage, artifact_ids: [] as string[] });
const outlineOf = (sections: ReturnType<typeof sp>[], keys: string[]): ReportOutline => ({ sections, questions: [],
  coverage: keys.map(key => ({ key, status: "qualified" as const, rationale: "Planned", section_ids: sections.filter(s => s.coverage.includes(key)).map(s => s.id) })) });

// AC-1, other shapes: evidence-only leftovers, several offending sections, and a second pass that changes nothing.
test("V-AC1: evidence+valuation and history+evidence+valuation sections both end up with a company key", () => {
  const raw = outlineOf([sp("summary", ["conclusion"]), sp("limits", ["evidence", "valuation"]), sp("past", ["history", "evidence", "valuation"]),
    sp("value", ["valuation", "forecasts", "downside"])], ["conclusion", "evidence", "history", "business", "valuation", "forecasts", "downside"]);
  const once = normalizeOutlineStructure(raw);
  assert.doesNotThrow(() => validateProductOutline(once));
  for (const id of ["limits", "past"]) {
    const s = once.sections.find(x => x.id === id)!;
    assert.ok(s.coverage.some(k => k !== "history" && k !== "evidence"), `${id} has a company key`);
    assert.ok(!s.coverage.includes("valuation"), `${id} no longer lists valuation`);
  }
  assert.deepEqual(normalizeOutlineStructure(once), once, "normalising twice changes nothing");
  assert.equal(raw.sections[1].coverage.includes("valuation"), true, "the input outline is not mutated");
});

test("V-AC1: an outline it cannot fix is still rejected (valuation only in the summary)", () => {
  const fixed = normalizeOutlineStructure(outlineOf([sp("summary", ["conclusion", "valuation"]), sp("past", ["history", "business"])], ["conclusion", "valuation", "history", "business"]));
  assert.throws(() => validateProductOutline(fixed));
});

// AC-2, other shapes.
const fill = () => (contracts as any).fillChartPlanGap as (plan: { chart_plan?: string }, section: ReportSection) => ReportSection;
const section = (over: Partial<ReportSection> = {}): ReportSection => ({ id: "segments", title: "Segments", purpose: "p", coverage: ["business"], artifact_ids: [],
  paragraphs: [{ kind: "analysis", text: "Lending earns most.", evidence_ids: [], artifact_ids: [] }], counterevidence: "c", implication: "i",
  gaps: ["Segment capital is not disclosed."], tables: [], ...over });

test("V-AC2: whitespace-only plans and plural 'charts' gaps leave the section unchanged", () => {
  assert.deepEqual(fill()({ chart_plan: "   " }, section()), section());
  const plural = section({ gaps: ["Charts are omitted: fewer than four quarters."] });
  assert.deepEqual(fill()({ chart_plan: "Segment mix (series) from segment_model" }, plural), plural);
});

test("V-AC2: the added gap keeps existing gaps, is reader-facing and names no stored-data identifiers", () => {
  const plan = { chart_plan: "Segment revenue mix (series, stacked) from historical_record chart_series segment_revenue_lending" };
  const out = fill()(plan, section());
  assert.equal(out.gaps.length, 2);
  assert.equal(out.gaps[0], "Segment capital is not disclosed.");
  const added = out.gaps[1];
  assert.doesNotMatch(added, /[a-z]+_[a-z_]+/, "no snake_case identifiers such as historical_record or chart_series");
  assert.doesNotMatch(added, /chart_plan|section_plan|artifact/i);
  assert.doesNotThrow(() => validateChartPlan(plan, out));
  assert.deepEqual(fill()(plan, out), out, "filling twice adds nothing");
});

// AC-3 .. AC-5 fixture.
const allMet = () => DEPTH_CHECKS.map(c => ({ id: c.id, status: "met" as const, section_id: "", why: "Present." }));
const input = { asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["conclusion", "business", "moat", "valuation"] };
const planned = () => ({ sections: [sp("summary", ["conclusion"]), sp("ops", ["business"]), sp("moat", ["moat"]), sp("value", ["valuation"])],
  questions: [] as any[], coverage: ["conclusion", "business", "moat", "valuation"].map(key => ({ key, status: "qualified", rationale: "Planned",
    section_ids: [({ conclusion: "summary", business: "ops", moat: "moat", valuation: "value" } as any)[key]] })) });
const body = (p: any, n: number) => ({ ...p, paragraphs: [{ kind: "analysis", text: `Volumes rose ${n}% in FY2025 for ${p.id}.`, evidence_ids: [], artifact_ids: [] }],
  counterevidence: "Rates.", implication: "Funding holds.", gaps: [], tables: [] });

function db() {
  const rows: { type: string; scope: string; content: any; current: boolean; id: number }[] = [];
  const current = (type: string, scope: string) => rows.find(r => r.type === type && r.scope === scope && r.current);
  return { rows, current, save(type: string, scope: string, value: any) {
    const prior = current(type, scope);
    if (prior && fingerprint(prior.content) === fingerprint(value)) return prior;
    if (prior) prior.current = false;
    const row = { id: rows.length + 1, type, scope, content: structuredClone(value), current: true };
    rows.push(row); return row;
  }, retain(type: string, scopes: string[]) { for (const r of rows) if (r.type === type && r.current && !scopes.includes(r.scope)) r.current = false; } };
}

type Hooks = { findings: Record<string, any>[]; onPlan?: (feedback: any[]) => void; onWrite?: (id: string, feedback: any[]) => Promise<void> | void; seen?: Map<string, string[][]> };
function acts(store: ReturnType<typeof db>, h: Hooks): CompositionActions {
  let reviews = 0;
  return {
    plan: async feedback => { if (feedback.length) h.onPlan?.(feedback); return planned() as any; },
    write: async (p, _o, feedback, _c, options) => {
      if (feedback.length) { h.seen?.set(p.id, [...(h.seen.get(p.id) ?? []), feedback.map(f => String(f.issue)).sort()]); await h.onWrite?.(p.id, feedback); }
      return { ...body(p, feedback.length ? 9 : 5), ...(options?.coverage ? { final_coverage: (options.coverage as any[]).map(c => ({ ...c, rationale: "Written." })) } : {}) } as any;
    },
    review: async () => { reviews++; return { review_summary: "r", quality_score: 0.4, recommendations: [], depth_checks: allMet(),
      review_verdict: reviews === 1 ? "fail" : "pass", findings: reviews === 1 ? h.findings : [] }; },
    rework: async () => [],
    save: async (t, s, v) => store.save(t, s, v),
    retain: async (t, s) => store.retain(t, s),
  };
}

async function setup() {
  const store = db();
  const draft = await composeDraft(input as any, acts(store, { findings: [] }));
  const ids = { outline: store.current("report_outline", "outline")!.id, sections: draft.sections.map(s => store.current("report_section", s.id)!.id) };
  const byId = (id: number) => store.rows.find(r => r.id === id)!.content;
  const reload = () => draftDocument(input as any, { outline: Outline.parse(byId(ids.outline)), sections: ids.sections.map(id => Section.parse(byId(id))), finalCoverage: draft.finalCoverage });
  const snapshot = Object.fromEntries(draft.sections.map(s => [s.id, fingerprint(store.current("report_section", s.id)!.content)]));
  return { store, draft, reload, snapshot };
}
const gap = (section_id: string | undefined, issue: string, category = "writing") => ({ ...(section_id ? { section_id } : {}), category, severity: "critical", issue, repair: "r" });
const wrapped = (type: string) => { const inner = new ResearchAgentRunError("Agent attempts exhausted: invalid", {} as any, { error_type: type });
  return new Error("Section writer failed", { cause: inner }); };

test("V-AC3: a re-plan (research_gap) that fails validation keeps the draft and the round-0 findings", async () => {
  const { store, draft, reload, snapshot } = await setup();
  const failure = new ResearchAgentRunError("Agent attempts exhausted: Structured output validation failed: report: Error: Integrate historical causes", {} as any, { error_type: "schema_validation" });
  const result = await reviewDraftedReport(input as any, acts(store, { findings: [gap("ops", "Funding mix unknown.", "research_gap")], onPlan: () => { throw failure; } }), reload());
  assert.equal(result.document.content_hash, draft.document.content_hash);
  assert.equal((result.review as any).repair?.status, "failed");
  assert.ok((result.review as any).findings.some((f: any) => f.issue === "Funding mix unknown."));
  for (const [id, fp] of Object.entries(snapshot)) assert.equal(fingerprint(store.current("report_section", id)!.content), fp);
  assert.equal(store.current("report_document", "document")!.content.content_hash, draft.document.content_hash);
});

test("V-AC3: a content failure found through the error's cause chain is absorbed; a slower sibling rewrite cannot overwrite the restored draft", async () => {
  const { store, draft, reload, snapshot } = await setup();
  const result = await reviewDraftedReport(input as any, acts(store, { findings: [gap("ops", "Thin ops."), gap("moat", "Thin moat."), gap("value", "Thin value.")],
    onWrite: async id => {
      if (id === "ops") throw wrapped("response_limit");
      await new Promise(r => setTimeout(r, 25));
    } }), reload());
  assert.equal((result.review as any).repair?.status, "failed");
  await new Promise(r => setTimeout(r, 60));
  for (const [id, fp] of Object.entries(snapshot)) assert.equal(fingerprint(store.current("report_section", id)!.content), fp, `${id} is still the draft's after siblings settle`);
  assert.equal(store.current("report_document", "document")!.content.content_hash, draft.document.content_hash);
});

test("V-AC3: running the review stage again after a failed repair starts from the same draft", async () => {
  const { store, draft, reload } = await setup();
  const failure = new ResearchAgentRunError("Agent attempts exhausted: x", {} as any, { error_type: "schema_validation" });
  await reviewDraftedReport(input as any, acts(store, { findings: [gap("ops", "Thin ops.")], onWrite: () => { throw failure; } }), reload());
  const again = await reviewDraftedReport(input as any, acts(store, { findings: [] }), reload());
  assert.equal(again.document.content_hash, draft.document.content_hash);
  assert.notEqual((again.review as any).repair?.status, "failed", "a passing review records no failed repair");
});

test("V-AC4: rate limits, authentication and quota stops are not absorbed, even through a cause chain", async () => {
  for (const type of ["rate_limit", "authentication", "quota_exceeded", "budget_exhausted"]) {
    const { store, reload } = await setup();
    const err = wrapped(type);
    await assert.rejects(reviewDraftedReport(input as any, acts(store, { findings: [gap("ops", "Thin.")], onWrite: () => { throw err; } }), reload()), e => e === err, type);
  }
});

test("V-AC5: in the research path every rewritten body section gets only its own and report-wide findings", async () => {
  const { store, reload } = await setup();
  const seen = new Map<string, string[][]>();
  await reviewDraftedReport(input as any, acts(store, { seen, findings: [gap("ops", "No funding data.", "research_gap"), gap("value", "Bridge missing.", "calculation"), gap(undefined, "Tone.")] }), reload());
  assert.deepEqual(seen.get("ops"), [["No funding data.", "Tone."]]);
  assert.deepEqual(seen.get("moat"), [["Tone."]]);
  assert.deepEqual(seen.get("value"), [["Bridge missing.", "Tone."]]);
  assert.deepEqual(seen.get("summary"), [["Bridge missing.", "No funding data.", "Tone."]]);
});
