// Independent checks for AC-4..AC-8 (plan author): empty, partial, withheld and malformed inputs, placement fallbacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXHIBITS, buildExhibits, placeExhibits, isAvailable, chapterExhibits, type BuiltExhibit } from "../../../src/lib/research/reporting/exhibits";
import { createReport } from "../../../src/lib/research/reporting/report";
import { SECTION_CONTRACT, storedSection } from "../../../src/lib/research/reporting/contracts";
import { artifacts, evidence, bodySection, artifact, analytics, valuation, operatingScenarios, ANALYTICS_ID, OPS_ID, VAL_ID, EVIDENCE_ID } from "../acceptance/fixtures";

test("V-AC-4: no artifacts gives every exhibit unavailable with a reason, never a throw", () => {
  const out = buildExhibits([]);
  assert.equal(out.length, EXHIBITS.length);
  for (const e of out) { assert.ok(!isAvailable(e)); assert.ok((e as any).unavailable.trim()); }
});

test("V-AC-4: a withheld valuation makes the valuation exhibits unavailable with the withheld reason; drivers stay", () => {
  const withheld = { ...valuation, valuation_status: "withheld", withheld_reason: "No stored close on or before the cutoff.",
    terminal_anchor_bear: 0, terminal_anchor_base: 0, terminal_anchor_bull: 0 };
  const out = buildExhibits([artifact(ANALYTICS_ID, "financial_analytics", analytics), artifact(OPS_ID, "operating_scenario_set", operatingScenarios),
    artifact(VAL_ID, "valuation_scenario_set", withheld)]);
  for (const key of ["scenario_values", "valuation_bridge", "valuation_matrix", "sensitivity_grid", "stress_cases"]) {
    const e = out.find(x => x.key === key)!;
    assert.ok(!isAvailable(e), key);
    assert.match((e as any).unavailable, /No stored close/);
  }
  assert.ok(isAvailable(out.find(x => x.key === "scenario_drivers")!));
});

test("V-AC-4: malformed or short analytics are unavailable, not thrown", () => {
  const broken = { ...analytics, quarterly: { columns: ["period"], rows: "oops" }, statistics: null,
    segments: { members: { columns: [], rows: [] }, quarterly: { columns: [], rows: [] }, annual: { columns: ["fiscal_year", "segment"], rows: [] } } };
  const out = buildExhibits([artifact(ANALYTICS_ID, "financial_analytics", broken)]);
  for (const key of ["quarterly_results", "history_statistics", "operating_margin_trend", "segment_economics"])
    assert.ok(!isAvailable(out.find(x => x.key === key)!), key);
  const one = { ...analytics, quarterly: { ...analytics.quarterly, rows: analytics.quarterly.rows.slice(-1) } };
  const trend = buildExhibits([artifact(ANALYTICS_ID, "financial_analytics", one)]).find(x => x.key === "operating_margin_trend")!;
  assert.ok(!isAvailable(trend), "a trend needs two points");
});

test("V-AC-4: a non-USD reporter labels its money in its own currency", () => {
  const cny = { ...analytics, currency: "CNY" };
  const e = buildExhibits([artifact(ANALYTICS_ID, "financial_analytics", cny)]).find(x => x.key === "quarterly_results") as BuiltExhibit;
  assert.match(e.caption, /CNY millions/);
  assert.doesNotMatch(e.caption, /USD/);
});

test("V-AC-4: negative ratios and money keep their sign", () => {
  const e = buildExhibits(artifacts).find(x => x.key === "segment_economics") as BuiltExhibit;
  const labs = e.table.rows.find(r => r.includes("Labs"))!;
  assert.ok(labs.some(c => /^[−-]17,000$/.test(c)), labs.join(" | "));
});

test("V-AC-5: without a history chapter, history exhibits fall back to business; conclusions never get exhibits", () => {
  const placed = placeExhibits([{ id: "verdict", coverage: ["conclusion"] }, { id: "ops", coverage: ["business", "moat"] },
    { id: "close", coverage: ["conclusion", "valuation"] }], buildExhibits(artifacts));
  assert.ok(placed.ops.includes("quarterly_results"));
  assert.deepEqual(placed.verdict, []);
  assert.deepEqual(placed.close, [], "a conclusion section is skipped even when it lists valuation");
});

test("V-AC-5: unavailable exhibits are never placed; nothing matching leaves an exhibit unplaced", () => {
  const placed = placeExhibits([{ id: "people", coverage: ["management"] }], buildExhibits([]));
  assert.deepEqual(placed.people, []);
  const only = placeExhibits([{ id: "moat", coverage: ["moat"] }], buildExhibits(artifacts));
  assert.deepEqual(only.moat, []);
});

test("V-AC-6: the writer contract still rejects a section without prose", () => {
  const empty = { section: { ...bodySection("b", ["business"]), paragraphs: [] } };
  assert.ok(SECTION_CONTRACT.validate!(empty).length > 0);
});

test("V-AC-6: storedSection drops quantitative visuals of every kind and keeps an organization chart", () => {
  const visuals = ["history", "series", "ratio", "scenarios", "valuation_bridge"].map(kind => ({ kind, title: "t", caption: "c" }));
  const org = { kind: "organization", title: "Leadership", caption: "c", as_of: "2025-06-30", people: [{ id: "ceo", name: "A. Person", role: "CEO", reports_to: null, evidence_ids: [EVIDENCE_ID] }] };
  const stored = storedSection({ ...bodySection("m", ["management"]), visuals: [...visuals, org] } as any, []);
  assert.deepEqual((stored.visuals ?? []).map(v => v.kind), ["organization"]);
  assert.deepEqual(stored.exhibits, []);
});

test("V-AC-7: a new report whose exhibits have no data renders without them and without throwing", () => {
  const doc = createReport({ asset_name: "Example Corp", cutoff: "2025-08-01T00:00:00.000Z", is_test: false, required_coverage: ["valuation"],
    // The section cites no artifact: with none stored, a citation would rightly fail the reference check (AC-7 keeps it).
    sections: [{ ...bodySection("val", ["valuation"], ["valuation_matrix", "scenario_values"]), artifact_ids: [] }], questions: [],
    coverage: [{ key: "valuation", status: "qualified", rationale: "Limited.", section_ids: ["val"] }], evidence, artifacts: [] } as any);
  assert.doesNotMatch(doc.markdown, /###/);
  assert.equal(chapterExhibits(doc, "val").length, 0);
});

test("V-AC-7: reference checks still run on new reports", () => {
  assert.throws(() => createReport({ asset_name: "X", cutoff: "2025-08-01T00:00:00.000Z", is_test: false, required_coverage: ["business"],
    sections: [{ ...bodySection("b", ["business"], ["quarterly_results"]), paragraphs: [{ kind: "fact", text: "t", evidence_ids: ["missing"], artifact_ids: [] }] }],
    questions: [], coverage: [{ key: "business", status: "satisfied", rationale: "r", section_ids: ["b"] }], evidence, artifacts } as any), /Unknown evidence/);
});

test("V-AC-7: the markdown prints a chart exhibit as its data table", () => {
  const doc = createReport({ asset_name: "Example Corp", cutoff: "2025-08-01T00:00:00.000Z", is_test: false, required_coverage: ["valuation"],
    sections: [bodySection("val", ["valuation"], ["scenario_values"])], questions: [],
    coverage: [{ key: "valuation", status: "satisfied", rationale: "r", section_ids: ["val"] }], evidence, artifacts } as any);
  assert.match(doc.markdown, /\|\s*Bear\s*\|/i);
});
