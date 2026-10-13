import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisual, ReportVisual, validateVisual, type ChartVisual } from '../src/lib/research/reporting/visuals';
import { validateChartPlan, type ReportSection } from '../src/lib/research/reporting/contracts';
import { createReport, type ReportArtifact } from '../src/lib/research/reporting/report';

const obs = (metric_key: string, fiscal_year: number, value_numeric: number | null, segment: string | null = null) =>
  ({ metric_key, fiscal_year, fiscal_quarter: null, value_numeric, segment, geography: null, unit: 'USD', currency: 'USD', reporting_basis: 'gaap', periodicity: 'annual' });
const method = (scenario_type: string, cash: number) => ({ method: 'fcff', method_name: 'Driver-based FCFF DCF', scenario_type, rationale: 'r', currency: 'USD',
  cash_flow_label: 'FCFF', discount_rate: 0.1, years: [{ fiscal_year: 2026, cash_flow: cash }, { fiscal_year: 2027, cash_flow: cash }],
  terminal: { type: 'multiple', metric: 'nopat', metric_value: 100, multiple: 10 }, equity_bridge: -50, equity_bridge_explanation: 'Cash less debt.', diluted_shares: 10, source_notes: ['n'] });
const scenario = (scenario_type: string, growth: number, revenue: number) => ({ scenario_type, yearly_drivers: [
  { fiscal_year: 2026, revenue_growth: growth, operating_margin: 0.3 }, { fiscal_year: 2027, revenue_growth: growth, operating_margin: 0.32 }],
  resulting_financial_statements_json: { 2026: { revenue }, 2027: { revenue: revenue * 1.1 } } });
const artifacts: ReportArtifact[] = [
  { id: 'hist', artifact_type: 'historical_record', scope_key: 'default', artifact_version: 1, content_json: { observations: [
    obs('revenue', 2023, 100e6), obs('revenue', 2024, 120e6), obs('revenue', 2025, 150e6),
    obs('revenue', 2023, 90e6, 'apps'), obs('revenue', 2024, 110e6, 'apps'), obs('revenue', 2025, 138e6, 'apps'),
    obs('revenue', 2023, 10e6, 'labs'), obs('revenue', 2024, 10e6, 'labs'), obs('revenue', 2025, 12e6, 'labs'),
    obs('operating_income', 2023, 30e6), obs('operating_income', 2024, 48e6), obs('operating_income', 2025, null),
    obs('operating_income', 2023, -5e6, 'labs'),
  ] } },
  { id: 'ops', artifact_type: 'operating_scenario_set', scope_key: 'default', artifact_version: 1, content_json: { scenarios: [scenario('bear', 0.02, 160), scenario('base', 0.08, 170), scenario('bull', 0.12, 180)] } },
  { id: 'val', artifact_type: 'valuation_scenario_set', scope_key: 'default', artifact_version: 1, content_json: { terminal_year: 2027,
    terminal_anchor_bear: 80, terminal_anchor_base: 100, terminal_anchor_bull: 130, current_market_price: 95,
    method_inputs: [method('bear', 50), method('base', 60), method('bull', 70)] } },
];
const base = { title: 'Chart', caption: 'Stored data.' };
const observed = { artifact_id: 'hist', path: 'observations', unit: 'USD', currency: 'USD', reporting_basis: 'gaap', periodicity: 'annual' };
const line = (label: string, metric_key: string, segment: string | null = null) => ({ label, metric_key, segment, geography: null });
const build = (v: unknown) => buildVisual(ReportVisual.parse(v) as ChartVisual, artifacts, '2026-06-30T00:00:00Z');

test('segment mix stacks segments of one metric from stored observations', () => {
  const chart = build({ kind: 'series', ...base, ...observed, stacked: true, lines: [line('Apps', 'revenue', 'apps'), line('Labs', 'revenue', 'labs')] });
  assert.equal(chart.display, 'stacked');
  assert.equal(chart.unit, 'USD millions');
  assert.deepEqual(chart.points.map(p => p.values), [[90, 10], [110, 10], [138, 12]]);
  assert.equal(chart.points[0].exact[0], '90,000,000 USD');
  // Stacking with the consolidated total, or a negative segment, would mislead.
  assert.throws(() => build({ kind: 'series', ...base, ...observed, stacked: true, lines: [line('Total', 'revenue'), line('Apps', 'revenue', 'apps')] }), /without the consolidated total/);
  assert.throws(() => build({ kind: 'series', ...base, ...observed, stacked: true, lines: [line('Labs', 'operating_income', 'labs'), line('Apps', 'revenue', 'apps')] }), /one metric/);
  assert.throws(() => build({ kind: 'series', ...base, ...observed, stacked: false, lines: [line('A', 'revenue'), line('B', 'revenue')] }), /Duplicate/);
  assert.throws(() => build({ kind: 'series', ...base, ...observed, stacked: false, lines: [line('A', 'revenue'), line('B', 'missing_metric')] }), /no stored observations/);
  assert.throws(() => ReportVisual.parse({ kind: 'series', ...base, ...observed, stacked: false, lines: [line('A', 'revenue'), line('B', 'revenue', 'apps')], values: [1, 2] }));
});

test('a margin is divided in code and missing inputs stay missing', () => {
  const chart = build({ kind: 'ratio', ...base, ...observed, numerator: line('Operating income', 'operating_income'), denominator: line('Revenue', 'revenue') });
  assert.equal(chart.unit, '%');
  assert.deepEqual(chart.points.map(p => p.values[0]), [30, 40, null]);
  assert.deepEqual(chart.points[1].exact, ['40%', '48,000,000 USD', '120,000,000 USD']);
  assert.throws(() => build({ kind: 'ratio', ...base, ...observed, numerator: line('Revenue', 'revenue'), denominator: line('Revenue', 'revenue') }), /two different/);
  assert.throws(() => build({ kind: 'ratio', ...base, ...observed, numerator: line('Labs income', 'operating_income', 'labs'), denominator: line('Labs revenue', 'revenue', 'labs') }), /at least two periods/);
});

test('scenario charts read bear, base and bull from the stored sets', () => {
  const value = build({ kind: 'scenarios', ...base, artifact_id: 'val', metric: 'value_per_share', unit: '' });
  assert.deepEqual(value.points.map(p => [p.period, p.values[0]]), [['Bear', 80], ['Base', 100], ['Bull', 130]]);
  assert.deepEqual(value.reference, { label: 'Current price', value: 95 });
  const growth = build({ kind: 'scenarios', ...base, artifact_id: 'ops', metric: 'revenue_growth', unit: '' });
  assert.equal(growth.unit, '%');
  assert.deepEqual(growth.points[0].values, [2, 8, 12]);
  const revenue = build({ kind: 'scenarios', ...base, artifact_id: 'ops', metric: 'revenue', unit: 'USD millions' });
  assert.deepEqual(revenue.points.map(p => p.period), ['FY2026', 'FY2027']);
  assert.deepEqual(revenue.points[0].values, [160, 170, 180]);
  assert.throws(() => build({ kind: 'scenarios', ...base, artifact_id: 'ops', metric: 'revenue', unit: '' }), /needs its unit/);
  assert.throws(() => build({ kind: 'scenarios', ...base, artifact_id: 'val', metric: 'revenue', unit: 'USD' }), /value_per_share/);
  assert.throws(() => build({ kind: 'scenarios', ...base, artifact_id: 'hist', metric: 'revenue', unit: 'USD' }), /reads/);
  const withheld = artifacts.map(a => a.id === 'val' ? { ...a, content_json: { valuation_status: 'withheld', terminal_anchor_bear: 0, terminal_anchor_base: 0, terminal_anchor_bull: 0, withheld_reason: 'No inputs' } } : a);
  assert.throws(() => buildVisual({ kind: 'scenarios', ...base, artifact_id: 'val', metric: 'value_per_share', unit: '' }, withheld), /withheld/);
});

test('the valuation bridge is recalculated from the stored method inputs', () => {
  const chart = build({ kind: 'valuation_bridge', ...base, artifact_id: 'val', scenario: 'base' });
  const pv = 60 / 1.1 + 60 / 1.21, tv = 1000 / 1.21;
  assert.deepEqual(chart.points.map(p => p.period), ['Forecast cash flows, discounted', 'Terminal value, discounted', 'Enterprise value', 'Net debt and leases', 'Equity value']);
  assert.ok(Math.abs(chart.points[2].values[0]! - (pv + tv)) < 1e-9);
  assert.ok(Math.abs(chart.points[4].values[0]! - (pv + tv - 50)) < 1e-9);
  // The net-debt step hangs down from enterprise value.
  assert.ok(Math.abs(chart.points[3].base! - (pv + tv - 50)) < 1e-9);
  assert.match(chart.notes[1], /10 million diluted shares/);
});

test('a planned chart is drawn or explained, and Markdown exports the data table', () => {
  const section: ReportSection = { id: 'valuation', title: 'Valuation', purpose: 'p', coverage: ['valuation'], artifact_ids: ['val'],
    paragraphs: [{ kind: 'analysis', text: 'Value.', evidence_ids: [], artifact_ids: ['val'] }], counterevidence: 'c', implication: 'i', gaps: [], tables: [] };
  const plan = { chart_plan: 'Bear/base/bull value per share from valuation_scenario_set' };
  assert.throws(() => validateChartPlan(plan, section), /plans a chart/);
  validateChartPlan(plan, { ...section, gaps: ['The chart is omitted because no stored scenario values exist.'] });
  validateChartPlan({}, section);
  const visual = { kind: 'scenarios' as const, ...base, artifact_id: 'val', metric: 'value_per_share', unit: '' };
  validateChartPlan(plan, { ...section, visuals: [visual] });
  validateVisual(visual, { artifacts, evidence: [], cutoff: '2026-06-30T00:00:00Z' });
  const report = createReport({ asset_name: 'Co', cutoff: '2026-06-30T00:00:00Z', is_test: true, required_coverage: ['valuation'],
    sections: [{ ...section, visuals: [visual] }], coverage: [{ key: 'valuation', status: 'qualified', rationale: 'r', section_ids: ['valuation'] }],
    questions: [], evidence: [], artifacts });
  assert.match(report.markdown, /\| Scenario \| Value per share \|\n\| --- \| --- \|\n\| Bear \| 80 USD \|/);
});
