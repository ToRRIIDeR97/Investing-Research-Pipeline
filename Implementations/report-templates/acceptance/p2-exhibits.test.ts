// AC-4, AC-5: code builds the report's tables and charts from stored artifacts and places them by coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXHIBITS, buildExhibits, placeExhibits, isAvailable, type BuiltExhibit } from "../../../src/lib/research/reporting/exhibits";
import { artifacts } from "./fixtures";

const LAUNCH_KEYS = ["quarterly_results", "history_statistics", "operating_margin_trend", "segment_economics", "cash_conversion",
  "capital_allocation", "scenario_drivers", "scenario_values", "valuation_bridge", "valuation_matrix", "sensitivity_grid", "stress_cases"];
const built = () => buildExhibits(artifacts, { cutoff: "2025-08-01T00:00:00.000Z" });
const get = (key: string) => {
  const exhibit = built().find(e => e.key === key);
  assert.ok(exhibit && isAvailable(exhibit), `${key} should be available`);
  return exhibit as BuiltExhibit;
};

test("AC-4: the catalogue holds the launch exhibits in a fixed order, each with a title and home coverage key", () => {
  assert.deepEqual(EXHIBITS.map(e => e.key), LAUNCH_KEYS);
  for (const e of EXHIBITS) { assert.ok(e.title.trim()); assert.ok(e.home.trim()); }
  assert.deepEqual(built().map(e => e.key), LAUNCH_KEYS);
});

test("AC-4: every exhibit is available from complete stored data", () => {
  for (const e of built()) assert.ok(isAvailable(e), `${e.key}: ${(e as any).unavailable}`);
});

test("AC-4: quarterly results show the last 8 quarters with reader labels and formatted cells", () => {
  const e = get("quarterly_results");
  assert.equal(e.kind, "table");
  assert.ok(e.table.rows.length <= 8);
  assert.equal(e.table.rows.at(-1)![0], "2025Q2");
  for (const column of e.table.columns) assert.doesNotMatch(column.label, /_/);
  const at = (label: RegExp) => e.table.columns.findIndex(c => label.test(c.label));
  const margin = at(/^operating margin$/i), revenue = at(/^revenue$/i);
  assert.ok(margin >= 0 && revenue >= 0);
  assert.equal(e.table.rows.at(-1)![margin], "39.0%");
  assert.equal(e.table.rows.at(-1)![revenue], "39,000");
  assert.match(e.caption, /USD millions/);
});

test("AC-4: missing values print as an em dash", () => {
  const e = get("quarterly_results");
  const yoy = e.table.columns.findIndex(c => /yoy/i.test(c.label));
  const full = buildExhibits(artifacts).find(x => x.key === "quarterly_results") as BuiltExhibit;
  assert.ok(yoy >= 0);
  // The fixture's first four quarters have no year-ago revenue; the last eight include two of them.
  assert.equal(full.table.rows[0][yoy], "—");
});

test("AC-4: history statistics format each metric by its kind", () => {
  const e = get("history_statistics");
  const row = (metric: RegExp) => e.table.rows.find(r => metric.test(r[0]))!;
  assert.ok(row(/operating margin/i), "metric labels are reader words");
  assert.ok(row(/operating margin/i).includes("35.0%"));
  assert.ok(row(/FCF TTM/).includes("40,589"));
});

test("AC-4: charts are built by code with their data table", () => {
  const trend = get("operating_margin_trend");
  assert.equal(trend.kind, "chart");
  if (trend.kind !== "chart") return;
  assert.equal(trend.chart.unit, "%");
  assert.ok(trend.chart.points.length >= 2);
  assert.ok(trend.table.rows.length >= 2);
  const values = get("scenario_values");
  assert.equal(values.kind, "chart");
  if (values.kind === "chart") assert.equal(values.chart.points.length, 3);
});

test("AC-4: valuation tables come from the stored valuation set", () => {
  const matrix = get("valuation_matrix");
  assert.ok(matrix.table.rows.some(r => r.includes("105.20")));
  const grid = get("sensitivity_grid");
  assert.ok(grid.table.rows.flat().includes("—"), "a null grid cell stays missing");
  const stress = get("stress_cases");
  assert.equal(stress.table.rows.length, 2);
  const drivers = get("scenario_drivers");
  assert.equal(drivers.table.rows.length, 2, "one row per forecast year");
  assert.ok(drivers.table.rows[0].includes("8.0%"));
});

test("AC-4: building is deterministic", () => {
  assert.equal(JSON.stringify(built()), JSON.stringify(built()));
});

test("AC-5: each available exhibit goes to the first body chapter covering its home area, once", () => {
  const sections = [
    { id: "summary", coverage: ["conclusion"] },
    { id: "business", coverage: ["business", "history"] },
    { id: "management", coverage: ["management"] },
    { id: "valuation", coverage: ["forecasts", "valuation", "downside"] },
    { id: "monitoring", coverage: ["monitoring"] },
  ];
  const placed = placeExhibits(sections, built());
  assert.deepEqual(Object.keys(placed).sort(), sections.map(s => s.id).sort());
  assert.deepEqual(placed.summary, []);
  assert.deepEqual(placed.monitoring, []);
  assert.ok(placed.business.includes("quarterly_results"));
  assert.ok(placed.business.includes("segment_economics"));
  assert.ok(placed.management.includes("capital_allocation"));
  for (const key of ["scenario_drivers", "scenario_values", "valuation_bridge", "valuation_matrix", "sensitivity_grid", "stress_cases"])
    assert.ok(placed.valuation.includes(key), key);
  const all = Object.values(placed).flat();
  assert.equal(all.length, new Set(all).size);
});
