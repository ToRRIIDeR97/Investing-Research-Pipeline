import test from "node:test";
import assert from "node:assert/strict";
import { CHART_PLAN_GAP, SECTION_CONTRACT, validateChartPlan, type ReportSection } from "../src/lib/research/reporting/contracts";
import { sectionWriteSteps } from "../src/lib/research/reporting/runtime";

type Written = { section: ReportSection };
const plan = { id: "segments", title: "Segments", purpose: "Explain the segments", coverage: ["business"], artifact_ids: [] as string[],
  chart_plan: "Segment revenue mix (series, stacked) from historical_record" };
const written = (over: Partial<ReportSection> = {}): Written => ({ section: { id: "segments", title: "Segments", purpose: "Explain the segments",
  coverage: ["business"], artifact_ids: [], paragraphs: [{ kind: "analysis", text: "Lending earns most of the revenue.", evidence_ids: [], artifact_ids: [] }],
  counterevidence: "Deposits could reprice.", implication: "Lending drives the thesis.", gaps: [], tables: [], ...over } });
const steps = (validate = (v: Written) => validateChartPlan(plan, v.section), check = (v: Written) => v) =>
  sectionWriteSteps<Written>(plan, SECTION_CONTRACT, check, validate);

test("a section write without its planned chart passes validation and is stored with the chart gap", () => {
  const s = steps();
  assert.deepEqual(SECTION_CONTRACT.validate?.(written()) ?? [], [], "the fixture meets the section schema");
  assert.throws(() => validateChartPlan(plan, written().section), "without the step the chart rule rejects it");
  assert.deepEqual(s.outputFormat.validate?.(written()), []);
  const stored = s.finish(written());
  assert.deepEqual(stored.section.gaps, [CHART_PLAN_GAP]);
  assert.deepEqual(s.finish(stored), stored, "finishing twice adds nothing");
});

test("the chart step runs after the reference check and hides no other validation error", () => {
  const seen: string[] = [];
  const s = steps(v => { seen.push(...v.section.gaps); throw new Error("Preserve section id and coverage exactly"); },
    v => { seen.push("checked"); return v; });
  const errors = s.outputFormat.validate?.(written()) ?? [];
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].message), /Preserve section id/);
  assert.deepEqual(seen, ["checked", CHART_PLAN_GAP]);
});

test("a visual that cannot be built from the stored data is dropped in code and the planned chart becomes a gap", () => {
  const scenarios = { id: "osc-1", artifact_type: "operating_scenario_set", content_json: { scenarios: ["bear", "base", "bull"].map(scenario_type => ({ scenario_type,
    yearly_drivers: [], resulting_financial_statements_json: { revenue_usd_millions: { 2027: 10, 2028: 12 } } })) } };
  const visualInput = { artifacts: [scenarios] as any, evidence: [], cutoff: "2026-11-18T00:00:00.000Z" };
  const visual = (metric: string) => ({ kind: "scenarios" as const, title: "Revenue by scenario", caption: "", artifact_id: "osc-1", metric, unit: "USD millions" });
  const s = sectionWriteSteps<Written>(plan, SECTION_CONTRACT, v => v, v => validateChartPlan(plan, v.section), visualInput);

  const bad = s.finish(written({ visuals: [visual("revenue_musd")] }));
  assert.deepEqual(bad.section.visuals, [], "the chart naming an unknown metric is dropped");
  assert.deepEqual(bad.section.gaps, [CHART_PLAN_GAP]);
  assert.deepEqual(s.outputFormat.validate?.(written({ visuals: [visual("revenue_musd")] })), []);

  const good = s.finish(written({ visuals: [visual("revenue_usd_millions")] }));
  assert.equal(good.section.visuals?.length, 1, "a chart that builds is kept");
  assert.deepEqual(good.section.gaps, []);
});

test("a section with no chart plan, or one that drew its chart, is stored unchanged", () => {
  const none = sectionWriteSteps<Written>({ ...plan, chart_plan: "" }, SECTION_CONTRACT, v => v, () => {});
  assert.deepEqual(none.finish(written()), written());
  const drawn = written({ gaps: ["Charts are omitted: fewer than four quarters."] });
  assert.deepEqual(steps().finish(drawn), drawn);
});
