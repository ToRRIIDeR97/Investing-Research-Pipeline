// Fixes for the bugs paid META run 27644c35 hit: analytics charts, the scenarios root key and the scenarios effort.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisual, ReportVisual, validateVisual, type ChartVisual } from '../src/lib/research/reporting/visuals';
import { validateChartPlan, type ReportSection } from '../src/lib/research/reporting/contracts';
import { createReport, type ReportArtifact } from '../src/lib/research/reporting/report';
import { parseStructuredOutput } from '../src/lib/agent-harness/output-parser';
import { resolveTaskEffort } from '../src/lib/agent-harness/registry';
import { taskExecution } from '../src/lib/research/model-tiering';

const table = (columns: string[], rows: unknown[][]) => ({ columns, rows });
const artifacts: ReportArtifact[] = [{ id: 'fa', artifact_type: 'financial_analytics', scope_key: 'default', artifact_version: 1, content_json: {
  currency: 'USD',
  cash_conversion: { quarterly: table(['period', 'fcf_ttm', 'fcf_to_net_income', 'capex_to_da'],
    [['2025Q3', 44_000, 0.72, 2.1], ['2025Q4', 46_000, 0.7, 2.4], ['2026Q1', 43_000, null, 2.8]]) },
  segments: { quarterly: table(['period', 'segment', 'revenue', 'operating_income'],
    [['2025Q4', 'Family of Apps', 47_000, 25_000], ['2025Q4', 'Reality Labs', 1_000, -5_000],
     ['2026Q1', 'Family of Apps', 48_000, 26_000], ['2026Q1', 'Reality Labs', 900, -4_500]]) },
} }];
const base = { title: 'Capex to D&A and FCF to net income', caption: 'Computed by code.', artifact_id: 'fa' };
const line = (label: string, column: string, segment: string | null = null) => ({ label, column, segment });
const build = (v: unknown) => buildVisual(ReportVisual.parse(v) as ChartVisual, artifacts);
const cash = { kind: 'analytics', ...base, table: 'financial_analytics.cash_conversion.quarterly', stacked: false,
  lines: [line('Capex / D&A', 'capex_to_da'), line('FCF / net income', 'fcf_to_net_income')] };

test('an analytics chart reads financial_analytics.cash_conversion.quarterly, ratios drawn as multiples', () => {
  const chart = build(cash);
  assert.equal(chart.display, 'lines');
  assert.equal(chart.unit, 'x');
  assert.deepEqual(chart.points.map(p => p.period), ['2025Q3', '2025Q4', '2026Q1']);
  assert.deepEqual(chart.points.map(p => p.values), [[2.1, 0.72], [2.4, 0.7], [2.8, null]], 'a missing value stays missing');
  assert.deepEqual(chart.points[0].exact, ['2.1x', '72%']);
  assert.match(chart.notes[0], /^From financial_analytics\.cash_conversion\.quarterly, computed by code/);
  // Money is in millions of the pack's currency; a ratio alone is a percent.
  assert.equal(build({ ...cash, lines: [line('FCF (TTM)', 'fcf_ttm')] }).unit, 'USD millions');
  const pct = build({ ...cash, lines: [line('FCF / net income', 'fcf_to_net_income')] });
  assert.equal(pct.unit, '%');
  assert.deepEqual(pct.points.map(p => p.values[0]), [72, 70, null]);
});

test('an analytics chart validates its table, columns, units and segments', () => {
  assert.throws(() => build({ ...cash, lines: [line('Missing', 'roic_ttm')] }), /no numeric column roic_ttm/);
  assert.throws(() => build({ ...cash, lines: [line('FCF', 'fcf_ttm'), line('Capex / D&A', 'capex_to_da')] }), /mix units/);
  assert.throws(() => build({ ...cash, lines: [line('A', 'capex_to_da'), line('B', 'capex_to_da')] }), /Duplicate/);
  assert.throws(() => build({ ...cash, table: 'cash_conversion.annual' }), /./);
  assert.throws(() => build({ ...cash, artifact_id: 'nope' }), /./);
  const segments = { kind: 'analytics', ...base, table: 'segments.quarterly', stacked: false,
    lines: [line('Apps', 'operating_income', 'Family of Apps'), line('Labs', 'operating_income', 'Reality Labs')] };
  const chart = build(segments);
  assert.deepEqual(chart.points.map(p => p.values), [[25_000, -5_000], [26_000, -4_500]]);
  assert.throws(() => build({ ...segments, lines: [line('Apps', 'operating_income')] }), /Name the segment/);
  assert.throws(() => build({ ...cash, lines: [line('Capex / D&A', 'capex_to_da', 'Family of Apps')] }), /no segments/);
  assert.throws(() => build({ ...segments, lines: [line('X', 'revenue', 'Unknown')] }), /Unknown segment/);
  assert.throws(() => build({ ...segments, stacked: true }), /negative/);
  assert.equal(build({ ...segments, stacked: true, lines: [line('Apps', 'revenue', 'Family of Apps'), line('Labs', 'revenue', 'Reality Labs')] }).display, 'stacked');
  assert.throws(() => build({ ...segments, stacked: true, lines: [line('Apps', 'revenue', 'Family of Apps'), line('Labs', 'operating_income', 'Reality Labs')] }), /one column/);
});

test('the chart plan that stopped run 27644c35 is satisfied by an analytics visual and exports to Markdown', () => {
  const section: ReportSection = { id: 'capital', title: 'Capital intensity', purpose: 'p', coverage: ['capital_allocation'], artifact_ids: ['fa'],
    paragraphs: [{ kind: 'analysis', text: 'Capex runs ahead of depreciation.', evidence_ids: [], artifact_ids: ['fa'] }],
    counterevidence: 'c', implication: 'i', gaps: [], tables: [] };
  const plan = { chart_plan: 'Capex to D&A and FCF to net income trend (ratio) from financial_analytics.cash_conversion.quarterly' };
  assert.throws(() => validateChartPlan(plan, section), /analytics/);
  const visual = ReportVisual.parse(cash) as ChartVisual;
  validateChartPlan(plan, { ...section, visuals: [visual] });
  validateVisual(visual, { artifacts, evidence: [], cutoff: '2026-06-30T00:00:00Z' });
  const report = createReport({ asset_name: 'Co', cutoff: '2026-06-30T00:00:00Z', is_test: true, required_coverage: ['capital_allocation'],
    sections: [{ ...section, visuals: [visual] }], coverage: [{ key: 'capital_allocation', status: 'qualified', rationale: 'r', section_ids: ['capital'] }],
    questions: [], evidence: [], artifacts });
  assert.match(report.markdown, /\| Period \| Capex \/ D&amp;A \| FCF \/ net income \|/);
  assert.match(report.markdown, /\| 2025Q3 \| 2\.1x \| 72% \|/);
});

const schema = { type: 'object', required: ['operating_scenario_set'], properties: { operating_scenario_set: {
  type: 'object', required: ['artifact_type', 'scenarios', 'forecast_years'], properties: {} } } };
const set = { artifact_type: 'operating_scenario_set_v3', scenarios: [{ case: 'base' }], forecast_years: [2026, 2027] };

test('an answer without its single root key is wrapped when its keys match the root schema', () => {
  assert.deepEqual(parseStructuredOutput(JSON.stringify(set), ['operating_scenario_set'], schema), { operating_scenario_set: set });
  // Without the schema, or when the keys do not match, it is still rejected.
  assert.throws(() => parseStructuredOutput(JSON.stringify(set), ['operating_scenario_set']), /missing required keys/);
  assert.throws(() => parseStructuredOutput(JSON.stringify({ scenarios: [] }), ['operating_scenario_set'], schema), /missing required keys/);
  // Two candidate objects are ambiguous.
  assert.throws(() => parseStructuredOutput(`${JSON.stringify(set)}\n${JSON.stringify(set)}`, ['operating_scenario_set'], schema), /./);
  // A correctly rooted answer is unchanged.
  assert.deepEqual(parseStructuredOutput(JSON.stringify({ operating_scenario_set: set }), ['operating_scenario_set'], schema), { operating_scenario_set: set });
});

test('a code fence inside a JSON string, or a stray brace before the JSON, does not hide the answer', () => {
  const answer = { operating_scenario_set: { ...set, note: 'Drivers:\n```\nrevenue = users x ARPU\n```\nend' } };
  assert.deepEqual(parseStructuredOutput(JSON.stringify(answer), ['operating_scenario_set'], schema), answer);
  assert.deepEqual(parseStructuredOutput(`Done } here:\n${JSON.stringify(answer)}`, ['operating_scenario_set'], schema), answer);
});

test('operating_scenarios defaults to medium effort; the stage env override still wins', () => {
  const saved = process.env.RESEARCH_STAGE_OPERATING_SCENARIOS_EFFORT, premium = process.env.RESEARCH_PREMIUM_EFFORT;
  try {
    delete process.env.RESEARCH_STAGE_OPERATING_SCENARIOS_EFFORT; delete process.env.RESEARCH_PREMIUM_EFFORT;
    assert.equal(taskExecution({ agentName: 'asset-analyst', modelTier: 'premium', stageKey: 'operating_scenarios' }).effort, 'medium');
    assert.equal(taskExecution({ agentName: 'asset-analyst', modelTier: 'premium', stageKey: 'asset_valuation' }).effort, 'high');
    process.env.RESEARCH_PREMIUM_EFFORT = 'xhigh';
    assert.equal(taskExecution({ agentName: 'asset-analyst', modelTier: 'premium', stageKey: 'operating_scenarios' }).effort, 'medium', 'the stage default beats the tier env');
    process.env.RESEARCH_STAGE_OPERATING_SCENARIOS_EFFORT = 'high';
    assert.equal(taskExecution({ agentName: 'asset-analyst', modelTier: 'premium', stageKey: 'operating_scenarios' }).effort, 'high');
    assert.equal(resolveTaskEffort({ tier: 'premium', stageDefault: 'default' }), undefined);
  } finally {
    if (saved === undefined) delete process.env.RESEARCH_STAGE_OPERATING_SCENARIOS_EFFORT; else process.env.RESEARCH_STAGE_OPERATING_SCENARIOS_EFFORT = saved;
    if (premium === undefined) delete process.env.RESEARCH_PREMIUM_EFFORT; else process.env.RESEARCH_PREMIUM_EFFORT = premium;
  }
});
