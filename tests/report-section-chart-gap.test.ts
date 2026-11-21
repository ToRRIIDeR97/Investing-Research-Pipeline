// Section writes under standard adaptive-3: writers return prose only and code sets the exhibits (storedSection).
// These replace the chart-plan gap tests: chart plans are no longer planned, validated or filled for new writes.
import test from "node:test";
import assert from "node:assert/strict";
import { SECTION_CONTRACT, type ReportSection } from "../src/lib/research/reporting/contracts";
import { sectionWriteSteps } from "../src/lib/research/reporting/runtime";

type Written = { section: ReportSection };
const plan = { id: "segments", title: "Segments", purpose: "Explain the segments", coverage: ["business"], artifact_ids: [] as string[] };
const written = (over: Record<string, unknown> = {}): Written => ({ section: { id: "segments", title: "Segments", purpose: "Explain the segments",
  coverage: ["business"], artifact_ids: [], paragraphs: [{ kind: "analysis", text: "Lending earns most of the revenue.", evidence_ids: [], artifact_ids: [] }],
  counterevidence: "Deposits could reprice.", implication: "Lending drives the thesis.", gaps: [], ...over } as unknown as ReportSection });
const chart = { kind: "scenarios" as const, title: "Revenue by scenario", caption: "", artifact_id: "osc-1", metric: "revenue", unit: "USD millions" };
const evidence = { id: "ev-1", claim_text: "c", source_title: "10-K", url: "https://example.com/10k", published_at: "2026-01-01T00:00:00.000Z", location: "p. 4", quote: "Loans fund the deposits." };
const lane = (evidence_ids: string[]) => ({ nodes: [{ label: "Deposits", icon: "bank" }, { label: "Loans", icon: "document" }], note: "n", relationship: "documented", evidence_ids, artifact_ids: [] });
const process = (evidence_ids: string[]) => ({ kind: "process" as const, title: "How deposits fund loans", caption: "c", lanes: [lane(evidence_ids)] });

test("a write that still sends tables, a chart plan and a chart passes and is stored as prose with the placed exhibits", () => {
  const s = sectionWriteSteps<Written>(plan, SECTION_CONTRACT, v => v, () => {}, undefined, ["segment_economics", "cash_conversion"]);
  const answer = written({ chart_plan: "Segment mix", tables: [{ title: "Segments", artifact_id: "a1", path: "segments.annual" }], visuals: [chart] });
  assert.deepEqual(s.outputFormat.validate?.(answer), []);
  const stored = s.finish(answer);
  assert.deepEqual(stored.section.tables, []);
  assert.deepEqual(stored.section.visuals, []);
  assert.equal("chart_plan" in stored.section, false);
  assert.deepEqual(stored.section.exhibits, ["segment_economics", "cash_conversion"]);
  assert.deepEqual(stored.section.gaps, [], "no chart gap is added for new writes");
  assert.deepEqual(s.finish(stored), stored, "finishing twice changes nothing");
});

test("the store step runs after the reference check and hides no other validation error", () => {
  const seen: string[] = [];
  const s = sectionWriteSteps<Written>(plan, SECTION_CONTRACT, v => { seen.push("checked"); return v; },
    v => { seen.push(`tables ${v.section.tables.length}`); throw new Error("Preserve section id and coverage exactly"); });
  const errors = s.outputFormat.validate?.(written({ tables: [{ title: "t", artifact_id: "a1", path: "" }] })) ?? [];
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].message), /Preserve section id/);
  assert.deepEqual(seen, ["checked", "tables 0"]);
});

test("a process visual is kept when its sources check, and dropped in code when they don't", () => {
  const visualInput = { artifacts: [], evidence: [evidence], cutoff: "2026-11-18T00:00:00.000Z" };
  const s = sectionWriteSteps<Written>(plan, SECTION_CONTRACT, v => v, () => {}, visualInput);
  assert.deepEqual(s.finish(written({ visuals: [process(["ev-1"])] })).section.visuals?.map(v => v.kind), ["process"]);
  assert.deepEqual(s.finish(written({ visuals: [process(["ev-missing"])] })).section.visuals, []);
  assert.deepEqual(s.finish(written()).section.exhibits, [], "no exhibits placed means an empty list");
});

test("a section without prose is still rejected", () => {
  const errors = SECTION_CONTRACT.validate?.(written({ paragraphs: [] })) ?? [];
  assert.ok(errors.some(e => e.path.includes("paragraphs")));
});
