import test from "node:test";
import assert from "node:assert/strict";
import { DEPTH_CHECKS } from "../src/lib/research/reporting/depth";
import { composeDraft, composeReviewedReport, draftDocument, reviewDraftedReport, type CompositionActions } from "../src/lib/research/reporting/compose";
import { Outline, Section } from "../src/lib/research/reporting/contracts";

// Architecture-9 P4: report_draft writes the draft, ai_reviewer rebuilds it from stored artifacts and reviews it.
// Every call either stage makes must see the arguments, byte for byte, that one composition passed.

const allMet = () => DEPTH_CHECKS.map(c => ({ id: c.id, status: "met" as const, section_id: "", why: "Present." }));
const plan = (id: string, coverage: string[]) => ({ id, title: `${id} title`, purpose: "Explain", coverage, artifact_ids: [], key_figures: ["FY2024 revenue"] });
const input = { asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["conclusion", "valuation", "downside"] };
const outline = { sections: [plan("summary", ["conclusion"]), plan("valuation", ["valuation", "downside"])], questions: [], coverage: [
  { key: "conclusion", status: "qualified", rationale: "Planned", section_ids: ["summary"] },
  { key: "valuation", status: "qualified", rationale: "Planned", section_ids: ["valuation"] },
  { key: "downside", status: "satisfied", rationale: "Planned", section_ids: ["valuation"] }] };

/** jsonb keeps no key order: store a value with every object's keys reversed, as a reorder would. */
const jsonb = (value: unknown): any => Array.isArray(value) ? value.map(jsonb)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, jsonb((value as any)[key])])) : value;

/** Records every call's arguments as the JSON a prompt would serialize. */
function recorder(firstReview: "pass" | "fail") {
  const calls: string[] = [];
  const saved = new Map<string, unknown>();
  let reviews = 0;
  const actions: CompositionActions = {
    plan: async feedback => { calls.push(`plan ${JSON.stringify(feedback)}`); return structuredClone(outline) as any; },
    write: async (p, o, feedback, completed, options) => {
      calls.push(`write ${JSON.stringify([p, o, feedback, completed, options ?? null])}`);
      return { paragraphs: [{ kind: "analysis", text: `${p.id} text ${feedback.length}`, evidence_ids: [], artifact_ids: [] }],
        implication: "Margins hold.", counterevidence: "Competition.", tables: [], gaps: [], ...p,
        ...(options?.coverage ? { final_coverage: options.coverage.map(c => ({ ...c, status: "qualified", rationale: "Written." })) } : {}) } as any;
    },
    review: async document => {
      calls.push(`review ${JSON.stringify(document)}`);
      const failing = firstReview === "fail" && ++reviews === 1;
      return { review_summary: "x", quality_score: 0.5, recommendations: [], review_verdict: failing ? "fail" : "pass", depth_checks: allMet(),
        findings: failing ? [{ section_id: "valuation", category: "writing", severity: "high", issue: "Thin." }] : [] };
    },
    rework: async () => { calls.push("rework"); return []; },
    save: async (type, scope, value) => { calls.push(`save ${type} ${scope}`); saved.set(`${type}:${scope}`, structuredClone(value)); return { id: `${type}:${scope}` }; },
  };
  return { calls, saved, actions };
}

for (const firstReview of ["pass", "fail"] as const) {
  test(`a split draft and review make the same calls as one composition (first review ${firstReview}s)`, async () => {
    const one = recorder(firstReview);
    const whole = await composeReviewedReport(input as any, one.actions);

    const draftStage = recorder(firstReview);
    const draft = await composeDraft(input as any, draftStage.actions);
    // The review stage reads the draft back from artifacts stored as jsonb.
    const outlineBack = Outline.parse(jsonb(draftStage.saved.get("report_outline:outline")));
    const sectionsBack = draft.sections.map(s => Section.parse(jsonb(draftStage.saved.get(`report_section:${s.id}`))));
    const rebuilt = draftDocument(input as any, { outline: outlineBack, sections: sectionsBack, finalCoverage: jsonb(draft.finalCoverage) });
    assert.equal(rebuilt.document.content_hash, draft.document.content_hash);
    assert.equal(JSON.stringify(rebuilt.document), JSON.stringify(draft.document), "the rebuilt document is the same object, key order included");
    const reviewStage = recorder(firstReview);
    const split = await reviewDraftedReport(input as any, reviewStage.actions, rebuilt);

    assert.deepEqual([...draftStage.calls, ...reviewStage.calls], one.calls);
    assert.ok(!reviewStage.calls.some(call => call.startsWith(firstReview === "pass" ? "write" : "plan")),
      firstReview === "pass" ? "a passing first review writes nothing" : "a writing repair does not re-plan");
    assert.equal(split.document.content_hash, whole.document.content_hash);
    assert.equal(JSON.stringify(split.review), JSON.stringify(whole.review));
  });
}
