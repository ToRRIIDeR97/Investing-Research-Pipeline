// The investing notebook's pure parts: request contracts, pin and KPI readings from a run's artifacts, and where a
// report annotation lands on the report it was written on and on a newer one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationCreate, journalCreate, kpiCreate, pinCreate, pinUpdate, type NotebookAnnotation, type NotebookKpi, type NotebookPin } from "../src/lib/research/notebook/contracts";
import { kpiReading, kpiSnapshot, notebookMonitorItems, pinViews, placeAnnotation, placeAnnotations } from "../src/lib/research/notebook/readings";
import { scoreDashboard } from "../src/lib/research/monitoring/monitor-score";

const RUN = "00000000-0000-4000-8000-000000000001";
const OLD_RUN = "00000000-0000-4000-8000-000000000002";
const KPI_ID = "00000000-0000-4000-8000-000000000003";
const now = "2026-11-21T00:00:00.000Z";

const obs = (metric_key: string, year: number, quarter: number, value: number) => ({ metric_key, periodicity: "quarterly", fiscal_year: year, fiscal_quarter: quarter,
  value_numeric: value, unit: "USD", currency: "USD", reporting_basis: "gaap", period_start: `${year}-${String(quarter * 3 - 2).padStart(2, "0")}-01`,
  period_end: `${year}-${String(quarter * 3).padStart(2, "0")}-28`, metadata_json: { statement: "income" } });
const quarters = [[2025, 3], [2025, 4], [2026, 1], [2026, 2]] as const;
const observations = quarters.flatMap(([y, q], i) => [obs("us_gaap_Revenues", y, q, 1000e6 + i * 100e6), obs("us_gaap_OperatingIncomeLoss", y, q, 300e6 + i * 50e6)]);
const analytics = { artifact_type: "financial_analytics", currency: "USD", units: "millions",
  quarterly: { columns: ["period", "revenue", "operating_income", "revenue_yoy", "gross_margin", "operating_margin", "fcf_margin"],
    rows: [["2026Q1", 1200, 400, 0.2, 0.8, 0.333, 0.25], ["2026Q2", 1300, 450, 0.22, 0.8, 0.346, 0.26]] } };
const artifacts = [
  { id: "a1", artifact_type: "financial_statement_set", artifact_version: 1, content_json: { observations } },
  { id: "a2", artifact_type: "financial_analytics", artifact_version: 1, content_json: analytics },
];
const pin = (over: Partial<NotebookPin>): NotebookPin => ({ id: "p", kind: "exhibit", ref_key: "quarterly_results", frequency: "", note: "", position: 0, created_at: now, updated_at: now, ...over });
const kpi = (over: Partial<NotebookKpi>): NotebookKpi => ({ id: KPI_ID, label: "Operating margin", metric_key: "metric:operating_margin", segment: null,
  bear_line: 30, bull_line: 40, note: "", position: 0, created_at: now, updated_at: now, ...over });
const note = (over: Partial<NotebookAnnotation>): NotebookAnnotation => ({ id: "n", research_run_id: RUN, section_id: "business", section_title: "Business",
  section_coverage: ["business", "history"], exhibit_key: null, paragraph_index: null, quote: "", body: "Watch the ad load.", created_at: now, updated_at: now, ...over });

test("contracts accept only references code can draw, and clean the text people type", () => {
  assert.ok(pinCreate.safeParse({ kind: "exhibit", ref_key: "quarterly_results" }).success);
  assert.ok(!pinCreate.safeParse({ kind: "exhibit", ref_key: "made_up" }).success, "unknown exhibit");
  assert.ok(!pinCreate.safeParse({ kind: "metric", ref_key: "operating_margin" }).success, "a metric pin needs its frequency");
  assert.ok(pinCreate.safeParse({ kind: "metric", ref_key: "operating_margin", frequency: "annual" }).success);
  assert.ok(!pinCreate.safeParse({ kind: "metric", ref_key: "nope", frequency: "annual" }).success, "unknown metric");
  assert.ok(!pinCreate.safeParse({ kind: "exhibit", ref_key: "quarterly_results", values: [1] }).success, "no extra fields, so no values");
  assert.ok(!pinUpdate.safeParse({}).success);
  const k = kpiCreate.parse({ label: "  Margin\u0000 one\nline ", metric_key: "metric:operating_margin", bear_line: 30, bull_line: 40 });
  assert.equal(k.label, "Margin one line");
  assert.ok(!kpiCreate.safeParse({ label: "x", metric_key: "metric:nope" }).success);
  assert.ok(!kpiCreate.safeParse({ label: "x", metric_key: "a b" }).success);
  assert.ok(!kpiCreate.safeParse({ label: "x", metric_key: "revenue", bear_line: 5, bull_line: 5 }).success, "lines must differ");
  assert.ok(kpiCreate.safeParse({ label: "Revenue", metric_key: "revenue" }).success, "an observation key works too");
  const a = annotationCreate.parse({ research_run_id: RUN, section_id: "business", body: "Line one\r\n\r\n\r\n\r\nLine two\u0007" });
  assert.equal(a.body, "Line one\n\nLine two");
  assert.ok(!annotationCreate.safeParse({ research_run_id: RUN, section_id: "business", body: "x", exhibit_key: "quarterly_results", paragraph_index: 1 }).success);
  assert.ok(!annotationCreate.safeParse({ research_run_id: RUN, section_id: "business", body: "   " }).success, "an empty note");
  assert.ok(!journalCreate.safeParse({ entry_date: "2026-11-21" }).success, "a journal entry needs words");
  assert.ok(!journalCreate.safeParse({ entry_date: "21/11/2026", thesis: "x" }).success);
  assert.ok(journalCreate.safeParse({ entry_date: "2026-11-21", thesis: "Ads reaccelerate.", price: 612.5, currency: "USD" }).success);
});

test("pins draw an exhibit or a metric from the run, and say why when the run lacks the data", () => {
  const views = pinViews([pin({ id: "m", kind: "metric", ref_key: "operating_margin", frequency: "quarterly", position: 1 }),
    pin({ id: "e", position: 0 }), pin({ id: "x", ref_key: "valuation_matrix", position: 2 })], artifacts);
  assert.deepEqual(views.map(v => [v.pin.id, v.kind]), [["e", "exhibit"], ["m", "metric"], ["x", "unavailable"]]);
  const metric = views[1];
  assert.ok(metric.kind === "metric");
  if (metric.kind === "metric") {
    assert.equal(metric.series.unit, "%");
    assert.equal(metric.series.points.at(-1)!.display, "34.6%", "450 / 1,300 in percent");
  }
  assert.match(views[2].kind === "unavailable" ? views[2].reason : "", /\.$/);
});

test("a KPI reads in its display unit and its status follows the operator's own lines", () => {
  const margin = kpiReading(kpi({}), observations);
  assert.equal(margin.display, "34.6%");
  assert.equal(margin.status, "healthy");
  assert.equal(kpiReading(kpi({ bear_line: 35, bull_line: 40 }), observations).status, "danger");
  assert.equal(kpiReading(kpi({ bear_line: null, bull_line: null }), observations).status, null);
  const revenue = kpiReading(kpi({ label: "Revenue", metric_key: "us_gaap_Revenues", bear_line: 1500, bull_line: 2000 }), observations);
  assert.equal(revenue.unit, "USD millions");
  assert.equal(revenue.value, 1300);
  assert.equal(revenue.status, "danger");
  const missing = kpiReading(kpi({ metric_key: "made_up_key" }), observations);
  assert.equal(missing.value, null);
  assert.ok(missing.reason.length > 0);
  const [snap] = kpiSnapshot([kpi({})], artifacts);
  assert.deepEqual([snap.kpi_id, snap.display, snap.status, snap.period], [KPI_ID, "34.6%", "healthy", "Q2 2026"]);
});

test("monitor-check scores a notebook KPI in the unit its lines use", () => {
  const items = notebookMonitorItems([kpi({ bear_line: 35, bull_line: 45 })]);
  const fresh = [obs("us_gaap_Revenues", 2026, 3, 1000e6), obs("us_gaap_OperatingIncomeLoss", 2026, 3, 300e6)];
  const [result] = scoreDashboard(items, fresh, observations);
  assert.deepEqual([result.source, result.status, result.value, result.period], ["notebook", "danger", 30, "2026-Q3"]);
});

test("a note stays put on its own report and follows its exhibit or chapter to a newer one", () => {
  const document = { sections: [
    { id: "summary", coverage: ["conclusion"], exhibits: [] },
    { id: "ops", coverage: ["business", "moat"], exhibits: ["cash_conversion"] },
    { id: "valuation", coverage: ["forecasts", "valuation", "downside"], exhibits: ["valuation_matrix"] },
  ] } as any;
  // Written on this run, on a chapter that exists.
  assert.equal(placeAnnotation(note({ section_id: "ops", paragraph_index: 2 }), document, RUN).state, "attached");
  assert.equal(placeAnnotation(note({ section_id: "ops", paragraph_index: 2 }), document, RUN).paragraph_index, 2);
  // From an older run: the exhibit leads, wherever the newer report shows it.
  const byExhibit = placeAnnotation(note({ research_run_id: OLD_RUN, section_id: "old_chapter", exhibit_key: "valuation_matrix" }), document, RUN);
  assert.deepEqual([byExhibit.state, byExhibit.section_id, byExhibit.exhibit_key], ["carried", "valuation", "valuation_matrix"]);
  // Same chapter id; a paragraph anchor drops to the chapter.
  const byId = placeAnnotation(note({ research_run_id: OLD_RUN, section_id: "ops", paragraph_index: 3 }), document, RUN);
  assert.deepEqual([byId.state, byId.section_id, byId.paragraph_index], ["carried", "ops", null]);
  // Coverage overlap, never the opening conclusion.
  const byCoverage = placeAnnotation(note({ research_run_id: OLD_RUN, section_id: "gone", section_coverage: ["business", "history"] }), document, RUN);
  assert.deepEqual([byCoverage.state, byCoverage.section_id], ["carried", "ops"]);
  const lost = placeAnnotation(note({ research_run_id: OLD_RUN, section_id: "gone", section_coverage: ["management"] }), document, RUN);
  assert.equal(lost.state, "unattached");
  assert.equal(placeAnnotation(note({ research_run_id: null, section_id: "gone", section_coverage: [] }), document, RUN).state, "unattached", "a deleted run's note is kept");
  const placed = placeAnnotations([note({ section_id: "ops" }), lost.annotation], document, RUN);
  assert.equal(placed.bySection("ops").length, 1);
  assert.equal(placed.unattached.length, 1);
});
