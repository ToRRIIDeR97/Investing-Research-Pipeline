import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPriorResearch, priorResearchBytes, PRIOR_RESEARCH_MAX_BYTES, type PriorResearchInputs } from "../src/lib/research/lineage/prior-research";
import { buildVersionChangeLog, changeLogMarkdown, valuationSnapshot } from "../src/lib/research/lineage/change-log";
import { buildScenarioStatements } from "../src/lib/research/valuation/engine";
import { calculateValuationSchedule } from "../src/lib/research/valuation/schedules";
import { buildFcffValuation, type ValuationSet } from "../src/lib/research/valuation/v2";
import { createReport, type ReportInput } from "../src/lib/research/reporting/report";
import { refreshDecision, scoreDashboard } from "../src/lib/research/monitoring/monitor-score";
import { checkAsset, edgarFetch } from "../src/lib/research/monitoring/monitor-check";
import type { Sql } from "../src/lib/research/run-context";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const valuation = (weighted: number, base: number, discount = 0.09) => ({ artifact_type: "valuation_scenario_set", artifact_version: 1, status: "accepted", content_json: {
  artifact_type: "valuation_scenario_set", valuation_status: "complete", weighted_target: weighted, current_market_price: 100,
  probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25, terminal_anchor_bear: 8, terminal_anchor_base: 12, terminal_anchor_bull: 16,
  method_schedules: ["bear", "base", "bull"].map((t, i) => ({ scenario_type: t, currency: "USD", value_per_share: t === "base" ? base : 50 + i * 50, discount_rate: discount })),
} });
const artifacts = (weighted: number, base: number, decision = "pending", discount = 0.09) => [
  valuation(weighted, base, discount),
  { artifact_type: "operating_scenario_set", artifact_version: 1, status: "accepted", content_json: { scenarios: [{ scenario_type: "base", revenue_cagr: 0.08, operating_margin: 0.3 }] } },
  { artifact_type: "decision_record", artifact_version: 1, status: "accepted", content_json: { decision, rationale: "Valuation supports tracking." } },
  { artifact_type: "investment_thesis", artifact_version: 1, status: "accepted", content_json: { thesis_statement: "Ads compound." } },
  { artifact_type: "question_register", artifact_version: 2, status: "validated", content_json: { questions: [
    { id: "q-gov", question: "Who controls voting power?", status: "blocked", follow_up: "Retrieve the latest DEF 14A.", materiality: "material" },
    { id: "q-ok", question: "Is revenue growing?", status: "answered", follow_up: "", materiality: "critical" }] } },
  { artifact_type: "team_requests", artifact_version: 1, status: "validated", content_json: { requests: [
    { id: "r1", role: "valuation", question: "Source a documented beta.", source_role: "market_data", response: { status: "unavailable" } },
    { id: "r2", role: "business", question: "Segment margins?", response: { status: "answered" } }] } },
];
const priorInputs = (documents = 3): PriorResearchInputs => ({
  run: { id: id(1), run_type: "deep_dive", status: "completed", source_cutoff_at: "2026-06-30T00:00:00.000Z", completed_at: "2026-07-02T00:00:00.000Z" },
  artifacts: artifacts(120, 110, "approve"),
  documents: Array.from({ length: documents }, (_, i) => ({ id: id(100 + i), title: `Filing ${i} ${"x".repeat(100)}`, published_at: `2026-0${1 + (i % 6)}-01` })),
  review: { status: "approved_for_tracking", open_questions: "Explain capex returns.", what_would_change_mind: null },
});

test("prior_research carries documents, blocked questions, unavailable requests, decision and valuation", () => {
  const block = buildPriorResearch(priorInputs());
  assert.equal(block.prior_run_id, id(1));
  assert.equal(block.review_status, "accepted");
  assert.equal(block.human_decision, "approved_for_tracking");
  assert.deepEqual(block.decision, { decision: "approve", rationale: "Valuation supports tracking.", thesis: "Ads compound." });
  assert.equal(block.documents.length, 3);
  assert.ok(block.documents.every(d => d.id && d.title));
  assert.deepEqual(block.blocked_questions, [{ question: "Who controls voting power?", follow_up: "Retrieve the latest DEF 14A.", materiality: "material" }]);
  assert.deepEqual(block.unavailable_requests, [{ role: "valuation", question: "Source a documented beta.", source_role: "market_data" }]);
  assert.equal(block.valuation_summary?.weighted_value_per_share, 120);
  assert.equal(block.valuation_summary?.cases.find(c => c.scenario_type === "base")?.value_per_share, 110);
  assert.deepEqual(block.human_follow_up, { open_questions: "Explain capex returns.", what_would_change_mind: null });
  assert.deepEqual(block.omitted, { documents: 0, blocked_questions: 0, unavailable_requests: 0 });
  // Deterministic: the same inputs give the same bytes, so the cached prefix is stable.
  assert.equal(JSON.stringify(buildPriorResearch(priorInputs())), JSON.stringify(block));
});

test("prior_research is capped at about 10 KB, dropping the oldest documents first", () => {
  const inputs = priorInputs(400);
  const block = buildPriorResearch(inputs);
  assert.ok(priorResearchBytes(block) <= PRIOR_RESEARCH_MAX_BYTES, `${priorResearchBytes(block)} bytes`);
  assert.ok(block.omitted.documents > 0);
  assert.equal(block.documents.length + block.omitted.documents, 400);
  // Questions and requests survive while documents can still be dropped.
  assert.equal(block.blocked_questions.length, 1);
  assert.equal(block.unavailable_requests.length, 1);
  // Newest documents are kept.
  const newest = inputs.documents.filter(d => String(d.published_at) === "2026-06-01").map(d => d.id);
  assert.ok(newest.some(n => block.documents.some(d => d.id === n)));
  // Long text is clipped too.
  const long = buildPriorResearch({ ...priorInputs(), review: { status: "approved_for_tracking", open_questions: "y".repeat(5000), what_would_change_mind: null } });
  assert.ok((long.human_follow_up?.open_questions?.length ?? 0) <= 400);
  // An unreviewed prior run is labelled so.
  const unreviewed = buildPriorResearch({ ...priorInputs(), artifacts: priorInputs().artifacts.map(a => ({ ...a, status: "validated" })), review: null });
  assert.equal(unreviewed.review_status, "unreviewed");
});

test("version_change_log diffs valuation, drivers, decision and thesis against the prior run", () => {
  const prior = { artifacts: artifacts(120, 110, "pending"), source_cutoff: "2026-06-30T00:00:00.000Z", document_ids: [id(100), id(101)] };
  const current = { artifacts: artifacts(102, 95, "approve", 0.1), source_cutoff: "2026-10-01T00:00:00.000Z", document_ids: [id(100), id(101), id(102)] };
  const log = buildVersionChangeLog(id(1), prior, current);
  const change = (field: string) => log.changes.find(c => c.field === field);
  assert.equal(log.artifact_type, "version_change_log");
  assert.equal(log.new_documents, 1);
  assert.equal(log.cause, "new_evidence");
  assert.deepEqual([change("valuation.weighted_value_per_share")?.previous, change("valuation.weighted_value_per_share")?.current], [120, 102]);
  assert.ok(Math.abs(change("valuation.weighted_value_per_share")!.change! + 0.15) < 1e-9);
  assert.equal(change("valuation.weighted_value_per_share")?.material, true);
  assert.equal(change("valuation.base.value_per_share")?.current, 95);
  assert.equal(change("valuation.bear.value_per_share"), undefined, "unchanged fields are counted, not listed");
  assert.equal(change("drivers.base.discount_rate")?.material, true, "0.09 to 0.10 is an 11% move");
  assert.deepEqual([change("decision.decision")?.previous, change("decision.decision")?.current, change("decision.decision")?.material], ["pending", "approve", true]);
  assert.equal(change("thesis.statement"), undefined);
  assert.ok(log.unchanged > 0);
  assert.equal(log.material_changes, log.changes.filter(c => c.material).length);
  // The same inputs on both sides: nothing changed, and with no new documents a change would be method or model.
  const same = buildVersionChangeLog(id(1), prior, { ...prior });
  assert.deepEqual([same.changes.length, same.cause], [0, "method_or_model"]);
  const lines = changeLogMarkdown(log).join("\n");
  assert.match(lines, /## Changes since the prior run/);
  assert.match(lines, /\| Probability-weighted terminal-year target \| 120\.00 \| 102\.00 \| −15\.0% \| Yes \|/);
  assert.match(lines, /\| Base case discount rate \| 9\.0% \| 10\.0% \|/);
});

const reportInput = (extra: ReportInput["artifacts"] = []): ReportInput => ({
  asset_name: "Example Inc.", cutoff: "2026-10-01T00:00:00.000Z", is_test: true, required_coverage: ["conclusion"],
  sections: [{ id: "summary", title: "Summary", coverage: ["conclusion"], purpose: "Summary", artifact_ids: [], paragraphs: [{ kind: "analysis", text: "Text.", evidence_ids: [], artifact_ids: [] }],
    counterevidence: "None.", implication: "Track.", gaps: [], tables: [] } as any],
  coverage: [{ key: "conclusion", status: "qualified", rationale: "Limited.", section_ids: ["summary"] }], questions: [], evidence: [],
  artifacts: [{ id: id(9), artifact_type: "valuation_scenario_set", scope_key: "v", artifact_version: 1, content_json: {} }, ...extra],
});

test("the report shows the change log only when the run has a prior; otherwise its bytes are unchanged", () => {
  const plain = createReport(reportInput());
  assert.ok(!plain.markdown.includes("Changes since the prior run"));
  const log = buildVersionChangeLog(id(1), { artifacts: artifacts(120, 110), source_cutoff: "2026-06-30T00:00:00.000Z", document_ids: [] },
    { artifacts: artifacts(102, 95), source_cutoff: null, document_ids: [] });
  const linked = createReport(reportInput([{ id: id(10), artifact_type: "version_change_log", scope_key: "c", artifact_version: 1, content_json: log as any }]));
  assert.match(linked.markdown, /## Changes since the prior run\n\nCompared with run 00000000-0000-4000-8000-000000000001 \(research cutoff 2026-06-30\)/);
  // Removing the change-log section gives back the report without it, so nothing else moved.
  assert.equal(linked.markdown.replace(/## Changes since the prior run[\s\S]*?(?=## Sources)/, ""), plain.markdown);
  // The stored report re-renders to the same hash (the approval integrity check).
  assert.equal(createReport(linked).content_hash, linked.content_hash);
});

const obs = (metric_key: string, year: number, quarter: number, value: number) => ({ metric_key, periodicity: "quarterly", fiscal_year: year, fiscal_quarter: quarter,
  value_numeric: value, unit: "USD", currency: "USD", reporting_basis: "gaap", period_start: `${year}-${String(quarter * 3 - 2).padStart(2, "0")}-01`,
  period_end: `${year}-${String(quarter * 3).padStart(2, "0")}-28`, metadata_json: { statement: "income" } });
const dashboard = [
  { kpi: "Capex intensity", metric_key: "capex_intensity", bear_threshold: 0.55, bull_threshold: 0.4, current_level: 0.495 },
  { kpi: "Operating margin", metric_key: "operating_margin", bear_threshold: 0.3, bull_threshold: 0.45, current_level: 0.41 },
  { kpi: "Ad impressions growth", metric_key: "ad_impressions_yoy_growth", bear_threshold: 0.05, bull_threshold: 0.15, current_level: 0.1 },
];

test("monitor scoring reads only the new quarter: capex intensity 0.57 is in danger, a made-up key is not checkable", () => {
  const fresh = [obs("us_gaap_Revenues", 2026, 3, 1000), obs("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", 2026, 3, 570), obs("us_gaap_OperatingIncomeLoss", 2026, 3, 420)];
  const context = [obs("us_gaap_Revenues", 2026, 2, 900), obs("us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", 2026, 2, 300)];
  const [capex, margin, impressions] = scoreDashboard(dashboard, fresh, context);
  assert.deepEqual([capex.status, capex.period, Number(capex.value!.toFixed(2))], ["danger", "2026-Q3", 0.57]);
  assert.deepEqual([margin.status, Number(margin.value!.toFixed(2))], ["healthy", 0.42]);
  assert.equal(impressions.status, "not_checkable");
  assert.match(impressions.reason, /ad_impressions_yoy_growth/);
  // Without new statements nothing is checkable, so the analyst's current level never counts as a fresh reading.
  assert.ok(scoreDashboard(dashboard, [], context).every(k => k.status === "not_checkable"));
  const due = refreshDecision({ filings: [{ form: "10-Q", filing_date: "2026-10-30", report_date: "2026-09-30", accession: "0001326801-26-000001", url: "", captured: true }],
    kpis: [capex, margin, impressions], nextRefreshAt: "2027-01-01T00:00:00.000Z", now: new Date("2026-11-01T00:00:00Z") });
  assert.equal(due.refresh_due, true);
  assert.deepEqual(due.reasons.map(r => r.split(" ")[0]), ["New", "Capex"]);
  assert.deepEqual(refreshDecision({ filings: [], kpis: [], nextRefreshAt: "2026-10-01T00:00:00.000Z", now: new Date("2026-11-01T00:00:00Z") }).reasons,
    ["Scheduled refresh date 2026-10-01 has passed."]);
  assert.equal(refreshDecision({ filings: [], kpis: [margin], nextRefreshAt: null, now: new Date() }).refresh_due, false);
});

test("monitor-check fetches only EDGAR hosts over HTTPS", async () => {
  const calls: string[] = [];
  const fetcher = edgarFetch((async (url: string | URL | Request) => { calls.push(String(url)); return new Response("{}"); }) as typeof fetch);
  await fetcher("https://data.sec.gov/submissions/CIK0000000001.json");
  await assert.rejects(fetcher("https://example.com/x"), /refuses/);
  await assert.rejects(fetcher("http://www.sec.gov/x"), /refuses/);
  assert.deepEqual(calls, ["https://data.sec.gov/submissions/CIK0000000001.json"]);
});

// A 10-Q in inline XBRL: three-month revenue and operating income for the quarter ending 2026-09-30.
const tenQ = `<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2026</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">Q3</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2026-09-30</ix:nonNumeric>
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
<xbrli:context id="q3"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>
<h2>Condensed Consolidated Statements of Income</h2><table>
<tr><td>Revenue</td><td><ix:nonFraction id="r" name="us-gaap:Revenues" contextRef="q3" unitRef="usd" scale="6" format="ixt:num-dot-decimal">1,000</ix:nonFraction></td></tr>
<tr><td>Income from operations</td><td><ix:nonFraction id="o" name="us-gaap:OperatingIncomeLoss" contextRef="q3" unitRef="usd" scale="6" format="ixt:num-dot-decimal">250</ix:nonFraction></td></tr>
</table>`;
const submissions = { filings: { recent: {
  form: ["10-Q", "8-K", "10-Q"], filingDate: ["2026-10-30", "2026-10-29", "2026-07-30"], accessionNumber: ["0000000001-26-000003", "0000000001-26-000002", "0000000001-26-000001"],
  reportDate: ["2026-09-30", "", "2026-06-30"], primaryDocument: ["q3.htm", "8k.htm", "q2.htm"], primaryDocDescription: ["", "", ""], items: ["", "", ""] } } };

test("monitor-check finds the 10-Q filed after the cutoff, captures it from a fixture and scores the dashboard", async () => {
  const calls: string[] = [];
  const fixtureFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).endsWith("CIK0000000001.json")) return new Response(JSON.stringify(submissions));
    if (String(url).endsWith("/q3.htm")) return new Response(tenQ);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const content: Record<string, unknown> = {
    monitoring_dashboard: { items: [dashboard[1], dashboard[2]] },
    refresh_schedule: { next_refresh_at: "2027-01-01T00:00:00.000Z" },
  };
  // A read-only stand-in for the database: no stored filing copy, and the run's artifacts by type.
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (/FROM source_documents/.test(text)) return [];
    if (/FROM research_artifacts/.test(text)) { const type = String(values[1]); return content[type] ? [{ content_json: content[type] }] : []; }
    throw new Error(`Unexpected query: ${text}`);
  }) as unknown as Sql;
  const result = await checkAsset(sql, { asset_id: id(5), slug: "example", symbol: "EXM", run_id: id(1), source_cutoff_at: "2026-08-01T00:00:00.000Z", cik: "0000000001" },
    { fetch: fixtureFetch, now: new Date("2026-11-01T00:00:00Z") });
  assert.deepEqual(result.filings.map(f => [f.form, f.filing_date, f.captured]), [["10-Q", "2026-10-30", true]], "only the 10-Q after the cutoff");
  assert.deepEqual(calls, ["https://data.sec.gov/submissions/CIK0000000001.json", "https://www.sec.gov/Archives/edgar/data/1/000000000126000003/q3.htm"]);
  const [margin, impressions] = result.kpis;
  assert.deepEqual([margin.status, margin.value, margin.period], ["danger", 0.25, "2026-Q3"]);
  assert.equal(impressions.status, "not_checkable");
  assert.equal(result.status, "refresh_due");
  assert.equal(result.reasons.length, 2);
  // Nothing new after a later cutoff: current, with no fetch beyond the submissions index.
  calls.length = 0;
  const quiet = await checkAsset(sql, { asset_id: id(5), slug: "example", symbol: "EXM", run_id: id(1), source_cutoff_at: "2026-10-31T00:00:00.000Z", cik: "0000000001" },
    { fetch: fixtureFetch, now: new Date("2026-11-01T00:00:00Z") });
  assert.deepEqual([quiet.status, quiet.filings.length, calls.length], ["current", 0, 1]);
});

// ---------------------------------------------------------------- valuation v2 artifacts
// The artifact is built by the real v2 engine and assembled the way handlers/asset-valuation.ts stores it.
const v2Ratios = { da_to_revenue: 0.05, capex_to_revenue: 0.06, tax_rate: 0.2 };
const v2Statements = (growth: number, margin: number, years: number) => buildScenarioStatements({ baseRevenue: 1000, baseYear: 2025, ratios: v2Ratios,
  drivers: Array.from({ length: years }, (_, i) => ({ fiscal_year: 2026 + i, revenue_growth: growth, operating_margin: margin })) });
const v2Set = (set: ValuationSet["set"], discount_rate: number, terminal_growth = 0.025): ValuationSet =>
  ({ set, discount_rate, terminal_growth, ronic: 0.2, fade_years: 5, rationale: "test" });
const v2Artifact = (years: number, baseRate: number) => {
  const built = buildFcffValuation({
    statements: { bear: v2Statements(0.03, 0.2, years), base: v2Statements(0.08, 0.25, years), bull: v2Statements(0.12, 0.3, years) },
    sets: [v2Set("conservative", baseRate + 0.01, 0.02), v2Set("base", baseRate), v2Set("aggressive", baseRate - 0.01, 0.03)],
    probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }, price: 400, currency: "USD",
    common: { bridge: 50, shares: 10, currency: "USD", sourceNotes: ["n"], bridgeExplanation: "Cash less debt." },
    timing: null, pack: null, fx: 1, capm: 0.09, riskFree: 0.04, historyRoic: 0.2,
  });
  const content: Record<string, any> = { ...built.assembled.valuation_scenario_set, ...built.additions };
  content.method_schedules = (content.method_inputs ?? []).map(calculateValuationSchedule);
  return { artifact_type: "valuation_scenario_set", artifact_version: 1, status: "accepted", content_json: content };
};

test("a valuation-v2 artifact is read for its matrix, weighted target, per-case values today and forecast years", () => {
  const artifact = v2Artifact(5, 0.09);
  const content = artifact.content_json;
  const snap = valuationSnapshot([artifact])!;
  assert.equal(snap.engine, "valuation-v2");
  assert.equal(snap.forecast_years, 5, "fade years are not forecast years");
  assert.equal(snap.terminal_year, content.terminal_year);
  assert.equal(snap.weighted_value_per_share, content.weighted_target);
  assert.equal(snap.weighted_value_today, content.weighted_value_today);
  for (const type of ["bear", "base", "bull"] as const) {
    const c = snap.cases.find(x => x.scenario_type === type)!;
    assert.equal(c.value_per_share, content[`value_today_${type}`]);
    assert.equal(c.terminal_anchor, content[`terminal_anchor_${type}`]);
    assert.equal(c.discount_rate, 0.09, "per-case schedules use the base set");
    assert.equal(c.probability, content[`probability_${type}`]);
  }
  assert.equal(snap.matrix.length, 9);
  const cell = content.valuation_matrix.rows.find((r: unknown[]) => r[0] === "bull" && r[1] === "aggressive");
  assert.equal(snap.matrix.find(m => m.case === "bull" && m.set === "aggressive")?.value_per_share, cell[5]);
  assert.deepEqual(snap.valuation_sets.map(s => [s.set, Number(s.discount_rate!.toFixed(4)), s.terminal_growth, s.ronic]),
    [["conservative", 0.1, 0.02, 0.2], ["base", 0.09, 0.025, 0.2], ["aggressive", 0.08, 0.03, 0.2]]);
  // prior_research carries the v2 summary within the cap.
  const block = buildPriorResearch({ ...priorInputs(), artifacts: [...priorInputs().artifacts.filter(a => a.artifact_type !== "valuation_scenario_set"), artifact] });
  assert.equal(block.valuation_summary?.matrix.length, 9);
  assert.equal(block.valuation_summary?.forecast_years, 5);
  assert.ok(priorResearchBytes(block) <= PRIOR_RESEARCH_MAX_BYTES);
});

test("the change log diffs two v2 valuations: forecast years, sets, matrix cells and weighted values", () => {
  const side = (artifact: ReturnType<typeof v2Artifact>) => ({ artifacts: [artifact], source_cutoff: null, document_ids: [] });
  const log = buildVersionChangeLog(id(1), side(v2Artifact(5, 0.09)), side(v2Artifact(7, 0.1)));
  const field = (name: string) => log.changes.find(c => c.field === name);
  assert.deepEqual([field("valuation.forecast_years")?.previous, field("valuation.forecast_years")?.current], [5, 7]);
  assert.deepEqual([field("drivers.set.base.discount_rate")?.previous, field("drivers.set.base.discount_rate")?.current], [0.09, 0.1]);
  assert.ok(field("valuation.weighted_value_today"), "weighted value today moved");
  assert.ok(field("valuation.weighted_value_per_share"));
  assert.ok(field("valuation.matrix.base.base"));
  assert.equal(field("drivers.set.base.ronic"), undefined, "an unchanged RONIC is not listed");
  assert.match(changeLogMarkdown(log).join("\n"), /\| Explicit forecast years \| 5 \| 7 \|/);
  // The same v2 artifact on both sides: nothing changes.
  assert.equal(buildVersionChangeLog(id(1), side(v2Artifact(5, 0.09)), side(v2Artifact(5, 0.09))).changes.length, 0);
});
