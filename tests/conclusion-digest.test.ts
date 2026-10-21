// Conclusion sections read code-built chapter digests instead of full chapter text (RQ-MOD-8).
import test from "node:test";
import assert from "node:assert/strict";
import { CONCLUSION_FIELD_BYTES, DIGEST_LIMITS, chapterDigest, conclusionArtifactView, conclusionInputs, reportSectionCall } from "../src/lib/research/reporting/runtime";
import type { ReportOutline, ReportSection } from "../src/lib/research/reporting/contracts";

const filler = "Advertising demand held up across regions while the cost base kept rising faster than revenue in the period under review";
const paragraph = (i: number, kind: ReportSection["paragraphs"][number]["kind"] = "analysis") => ({ kind,
  text: `${filler}. Revenue rose 1.5% to 4,210 million USD in Q${(i % 4) + 1} 2025. ${filler.repeat(6)}.`,
  evidence_ids: [`ev-${i}`, `ev-${i + 1}`], artifact_ids: [`art-${i % 3}`] });
const chapter = (id: string, paragraphs: number): ReportSection => ({ id, title: `Chapter ${id}`, purpose: "p", coverage: ["business"], artifact_ids: [],
  paragraphs: Array.from({ length: paragraphs }, (_, i) => paragraph(i, i === 2 ? "assumption" : "analysis")),
  counterevidence: `${filler}. `.repeat(20), implication: "Margins depend on capex flattening.", gaps: ["Segment revenue by quarter is not disclosed.", "x".repeat(900)], tables: [] });

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

test("a key point carries the paragraph's first figure, keeps decimals whole and marks assumptions", () => {
  const digest = chapterDigest(chapter("business", 3));
  assert.match(digest.key_points[0], /^Advertising demand [^.]*\. Revenue rose 1\.5% to 4,210 million USD in Q1 2025\.$/);
  assert.match(digest.key_points[2], /^\[assumption\] /);
});

test("a digest is bounded: points, summaries and gaps are capped, and it is far smaller than the chapter", () => {
  const section = chapter("business", 25);
  const digest = chapterDigest(section);
  for (const point of digest.key_points) assert.ok(point.length <= DIGEST_LIMITS.point, `point of ${point.length} chars`);
  assert.ok(digest.counterevidence.length <= DIGEST_LIMITS.summary);
  for (const gap of digest.gaps) assert.ok(gap.length <= DIGEST_LIMITS.gap);
  const ids = JSON.stringify([digest.evidence_ids, digest.artifact_ids]).length;
  const bound = section.paragraphs.length * (DIGEST_LIMITS.point + 3) + 2 * DIGEST_LIMITS.summary + section.gaps.length * (DIGEST_LIMITS.gap + 3) + ids + 400;
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

test("a conclusion's artifacts drop only fields larger than the cap and name them", () => {
  const artifact = { id: "val", artifact_type: "valuation_scenario_set", content_json: { valuation_status: "complete", method_schedules: [{ rows: "y".repeat(CONCLUSION_FIELD_BYTES) }] } };
  const view: any = conclusionArtifactView(artifact);
  assert.deepEqual(view.content_json, { valuation_status: "complete" });
  assert.deepEqual(view.omitted_fields, ["method_schedules"]);
  const small = { id: "c", artifact_type: "confidence_assessment", content_json: { data: "medium" } };
  assert.equal(conclusionArtifactView(small), small);
});

test("body packets carry full artifacts and no digests; conclusions get digests, capped artifacts and the final coverage", () => {
  const plan = (id: string, coverage: string[]) => ({ id, title: id, purpose: "p", coverage, artifact_ids: ["val"] });
  const outline: ReportOutline = { sections: [plan("summary", ["conclusion"]), plan("valuation", ["valuation", "forecasts", "downside"])],
    coverage: [{ key: "conclusion", status: "qualified", rationale: "r", section_ids: ["summary"] }], questions: [] };
  const big = { id: "val", artifact_type: "valuation_scenario_set", content_json: { method_schedules: "z".repeat(CONCLUSION_FIELD_BYTES + 1), status: "ok" } };
  const common = { evidence_claims: [{ id: "ev-0" }, { id: "ev-1" }, { id: "ev-7" }], filing_passages: ["passage"] };
  const body = reportSectionCall(common, [big], outline.sections[1], outline, [], []);
  assert.equal(body.packet.artifacts[0], big);
  assert.deepEqual(body.packet.completed_sections, []);
  assert.deepEqual(body.packet.evidence_claims, common.evidence_claims);
  assert.ok(!("provisional_coverage" in body.packet));
  const last = reportSectionCall(common, [big], outline.sections[0], outline, [], [chapter("valuation", 1)], outline.coverage);
  assert.deepEqual((last.packet.artifacts[0] as any).omitted_fields, ["method_schedules"]);
  assert.deepEqual(last.packet.evidence_claims.map(e => e.id), ["ev-0", "ev-1"]);
  assert.deepEqual(last.packet.filing_passages, []);
  assert.deepEqual(last.packet.provisional_coverage, outline.coverage);
  assert.deepEqual(last.contract.requiredKeys, ["section", "coverage"]);
  assert.equal((last.packet.completed_sections[0] as any).key_points.length, 1);
});
