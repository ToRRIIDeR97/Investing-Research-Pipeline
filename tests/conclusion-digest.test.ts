// Conclusion sections read code-built chapter digests instead of full chapter text (RQ-MOD-8).
import test from "node:test";
import assert from "node:assert/strict";
import { CONCLUSION_FIELD_BYTES, CONCLUSION_KEPT_FIELDS, DIGEST_LIMITS, chapterDigest, conclusionArtifactView, conclusionInputs, reportSectionCall } from "../src/lib/research/reporting/runtime";
import type { ReportOutline, ReportSection } from "../src/lib/research/reporting/contracts";

const filler = "Advertising demand held up across regions while the cost base kept rising faster than revenue in the period under review";
const paragraph = (i: number, kind: ReportSection["paragraphs"][number]["kind"] = "analysis") => ({ kind,
  text: `${filler}. Revenue rose 1.${i}% to 4,2${10 + i} million USD in Q${(i % 4) + 1} 2025, and total costs and expenses rose to 42.0${i}bn. ${filler.repeat(6)} with capex of ${100 + i} billion USD.`,
  evidence_ids: [`ev-${i}`, `ev-${i + 1}`], artifact_ids: [`art-${i % 3}`] });
const chapter = (id: string, paragraphs: number): ReportSection => ({ id, title: `Chapter ${id}`, purpose: "p", coverage: ["business"], artifact_ids: [],
  paragraphs: Array.from({ length: paragraphs }, (_, i) => paragraph(i, i === 2 ? "assumption" : "analysis")),
  counterevidence: `${filler}. `.repeat(20) + "The per-share bridge overstates value by 4.21 USD.", implication: "Margins depend on capex flattening.",
  gaps: ["Segment revenue by quarter is not disclosed.", "x".repeat(900)], tables: [] });
const FIGURE = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const textOf = (s: ReportSection) => [...s.paragraphs.map(p => p.text), s.counterevidence, s.implication, ...s.gaps].join(" ");

test("a digest keeps every cited evidence and artifact ID, the headline and one key point per paragraph", () => {
  const section = chapter("business", 12);
  const digest = chapterDigest(section);
  const cited = (key: "evidence_ids" | "artifact_ids") => new Set(section.paragraphs.flatMap(p => p[key]));
  assert.deepEqual(new Set(digest.evidence_ids), cited("evidence_ids"));
  assert.deepEqual(new Set(digest.artifact_ids), cited("artifact_ids"));
  assert.equal(digest.evidence_ids.length, cited("evidence_ids").size, "IDs are listed once");
  assert.equal(digest.title, section.title);
  assert.equal(digest.implication, section.implication);
  assert.equal(digest.key_points.length, section.paragraphs.length);
  assert.deepEqual(digest.gaps[0], section.gaps[0]);
});

test("every figure a chapter states reaches its digest, with its clause and decimals whole", () => {
  const section = chapter("business", 12);
  const digest = chapterDigest(section);
  const kept = new Set(JSON.stringify(digest).match(FIGURE));
  const missing = [...new Set(textOf(section).match(FIGURE))].filter(n => !kept.has(n));
  assert.deepEqual(missing, []);
  assert.ok(digest.other_figures.includes("Revenue rose 1.0% to 4,210 million USD in Q1 2025"), digest.other_figures.slice(0, 3).join(" | "));
  assert.ok(digest.other_figures.includes("total costs and expenses rose to 42.00bn"));
  assert.ok(digest.other_figures.some(f => f.includes("4.21 USD")), "a figure inside a long counterevidence sentence is kept");
  for (const clause of digest.other_figures) assert.ok(clause.length <= DIGEST_LIMITS.figure + 2, clause);
});

test("a key point is the paragraph's opening sentence and marks assumptions", () => {
  const digest = chapterDigest(chapter("business", 3));
  assert.equal(digest.key_points[0], `${filler}.`);
  assert.match(digest.key_points[2], /^\[assumption\] /);
});

test("a digest is bounded: points, summaries, gaps and figure clauses are capped, and it is far smaller than the chapter", () => {
  const section = chapter("business", 25);
  const digest = chapterDigest(section);
  for (const point of digest.key_points) assert.ok(point.length <= DIGEST_LIMITS.point, `point of ${point.length} chars`);
  assert.ok(digest.counterevidence.length <= DIGEST_LIMITS.summary);
  for (const gap of digest.gaps) assert.ok(gap.length <= DIGEST_LIMITS.gap);
  const ids = JSON.stringify([digest.evidence_ids, digest.artifact_ids]).length;
  const figures = new Set(textOf(section).match(FIGURE)).size;
  const bound = section.paragraphs.length * (DIGEST_LIMITS.point + 3) + 2 * DIGEST_LIMITS.summary + section.gaps.length * (DIGEST_LIMITS.gap + 3)
    + figures * (DIGEST_LIMITS.figure + 5) + ids + 400;
  const size = JSON.stringify(digest).length;
  assert.ok(size <= bound, `digest ${size} bytes over bound ${bound}`);
  assert.ok(size < JSON.stringify(section).length / 2, "digest is less than half the chapter");
});

test("conclusion inputs keep exactly the claims the chapters cite", () => {
  const chapters = [chapter("a", 2), chapter("b", 3)];
  const evidence = ["ev-0", "ev-1", "ev-2", "ev-3", "ev-9"].map(id => ({ id, claim_text: id }));
  const { chapters: digests, evidence: kept } = conclusionInputs(chapters, evidence);
  assert.deepEqual(kept.map(e => e.id), ["ev-0", "ev-1", "ev-2", "ev-3"]);
  assert.deepEqual(digests.map(d => d.id), ["a", "b"]);
});

test("a conclusion's artifacts drop only fields larger than the cap and name them; valuation v2 judgments are always kept", () => {
  const long = "y".repeat(CONCLUSION_FIELD_BYTES);
  const artifact = { id: "val", artifact_type: "valuation_scenario_set", content_json: { valuation_status: "complete", method_schedules: [{ rows: long }],
    ...Object.fromEntries(CONCLUSION_KEPT_FIELDS.map(key => [key, { rationale: long }])) } };
  const view: any = conclusionArtifactView(artifact);
  assert.deepEqual(Object.keys(view.content_json).sort(), ["valuation_status", ...CONCLUSION_KEPT_FIELDS].sort());
  assert.deepEqual(view.omitted_fields, ["method_schedules"]);
  const small = { id: "c", artifact_type: "confidence_assessment", content_json: { data: "medium" } };
  assert.deepEqual(conclusionArtifactView(small), small);
});

test("a conclusion reads historical_record through its model view: coverage gaps and reconciliation issues survive the cap", () => {
  const observations = Array.from({ length: 400 }, (_, i) => ({ metric_key: `metric_${i % 20}`, periodicity: "quarterly", unit: "USD", currency: "USD",
    value_numeric: i, fiscal_year: 2021 + Math.floor(i / 80), fiscal_quarter: (i % 4) + 1, reporting_basis: "reported" }));
  const history = { id: "hist", artifact_type: "historical_record", content_json: { artifact_type: "historical_record", asset_id: "a", observations,
    coverage: { start_fiscal_year: 2021, start_fiscal_quarter: 3, end_fiscal_year: 2026, end_fiscal_quarter: 2, quarters_required: 100, quarters_present: 98, is_complete: false,
      gaps: [{ why_missing: "Missing quarterly observation for capital_allocation in 2021Q3" }, { why_missing: "Missing quarterly observation for capital_allocation in 2025Q3" }] },
    reconciliation_issues: Array.from({ length: 55 }, (_, i) => ({ severity: i < 3 ? "blocking" : "warning", message: `issue ${i}` })) } };
  const plan = { id: "gaps", title: "Evidence quality", purpose: "p", coverage: ["evidence", "conclusion"], artifact_ids: ["hist"] };
  const outline: ReportOutline = { sections: [plan], coverage: [], questions: [] };
  const call = reportSectionCall({ evidence_claims: [] }, [history], plan, outline, [], [chapter("valuation", 1)], []);
  const view: any = call.packet.artifacts[0];
  assert.ok(!("observations" in view.content_json), "raw observations never reach the model");
  assert.deepEqual(view.content_json.coverage.first_gaps, history.content_json.coverage.gaps.map(g => g.why_missing));
  assert.equal(view.content_json.coverage.quarters_present, 98);
  assert.equal(view.content_json.reconciliation_issues.total, 55);
  assert.equal(view.content_json.reconciliation_issues.blocking, 3);
});

test("body packets carry full artifacts and no digests; conclusions get digests, capped artifacts, a slim outline and the final coverage", () => {
  const plan = (id: string, coverage: string[]) => ({ id, title: id, purpose: "p", coverage, artifact_ids: ["val"], chart_plan: "margin trend", key_figures: ["FY2025 margin"] });
  const outline: ReportOutline = { sections: [plan("summary", ["conclusion"]), plan("valuation", ["valuation", "forecasts", "downside"])],
    coverage: [{ key: "conclusion", status: "qualified", rationale: "r", section_ids: ["summary"] }], questions: [] };
  const big = { id: "val", artifact_type: "valuation_scenario_set", content_json: { method_schedules: "z".repeat(CONCLUSION_FIELD_BYTES + 1), status: "ok" } };
  const common = { evidence_claims: [{ id: "ev-0" }, { id: "ev-1" }, { id: "ev-7" }], filing_passages: ["passage"] };
  const body = reportSectionCall(common, [big], outline.sections[1], outline, [], []);
  assert.equal(body.packet.artifacts[0], big);
  assert.equal(body.packet.outline, outline);
  assert.deepEqual(body.packet.completed_sections, []);
  assert.deepEqual(body.packet.evidence_claims, common.evidence_claims);
  assert.ok(!("provisional_coverage" in body.packet));
  assert.ok(!body.extraRules.some(rule => rule.startsWith("completed_sections are code-built digests")));
  const last = reportSectionCall(common, [big], outline.sections[0], outline, [], [chapter("valuation", 1)], outline.coverage);
  assert.deepEqual((last.packet.artifacts[0] as any).omitted_fields, ["method_schedules"]);
  assert.deepEqual(last.packet.evidence_claims.map(e => e.id), ["ev-0", "ev-1"]);
  assert.deepEqual(last.packet.filing_passages, []);
  assert.deepEqual(last.packet.provisional_coverage, outline.coverage);
  assert.deepEqual(last.packet.outline.sections[1], { id: "valuation", title: "valuation", coverage: ["valuation", "forecasts", "downside"], key_figures: ["FY2025 margin"] });
  assert.deepEqual(last.packet.outline.coverage, outline.coverage);
  assert.deepEqual(last.packet.section_plan, outline.sections[0]);
  assert.deepEqual(last.contract.requiredKeys, ["section", "coverage"]);
  assert.equal((last.packet.completed_sections[0] as any).key_points.length, 1);
});
