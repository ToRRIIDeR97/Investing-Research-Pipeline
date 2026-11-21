// Code-built report exhibits (src/lib/research/reporting/exhibits.ts): unavailable inputs, formatting, placement and read-back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExhibits, chapterExhibits, isAvailable, placeExhibits, label, EXHIBITS, EXHIBIT_STANDARD, type BuiltExhibit, type Exhibit } from '../src/lib/research/reporting/exhibits';
import type { ReportArtifact, ReportDocument } from '../src/lib/research/reporting/report';

const quarters = ['2024Q1', '2024Q2', '2024Q3'];
const analytics = {
  artifact_type: 'financial_analytics', currency: 'EUR', window: { start: '2024Q1', end: '2024Q3', quarters: 3 },
  statistics: { columns: ['metric', 'n', 'median', 'min', 'max', 'latest', 'latest_period', 'percentile'], rows: [['capex_to_da', 3, 1.25, 1, 2, 1.5, '2024Q3', 0.5]] },
  quarterly: { columns: ['period', 'revenue', 'operating_income', 'revenue_yoy', 'gross_margin', 'operating_margin', 'fcf_margin'],
    rows: quarters.map((period, i) => [period, 1234.56 + i, -50 - i, null, 0.5, -0.0004 + i * 0.1, 0.1]) },
  segments: { members: { columns: [], rows: [] }, quarterly: { columns: [], rows: [] }, annual: { columns: ['fiscal_year', 'segment', 'revenue'], rows: [] } },
  cash_conversion: { quarterly: 'not a table', incremental: { columns: [], rows: [] } },
  capital_allocation: { quarterly: { columns: ['period', 'net_cash'], rows: [['2024Q3', -1234567.89]] }, share_classes: { columns: [], rows: [] }, notes: [] },
};
const art = (id: string, artifact_type: string, content_json: Record<string, any>, artifact_version = 1): ReportArtifact =>
  ({ id, artifact_type, scope_key: 'default', artifact_version, content_json });
const byKey = (list: Exhibit[], key: string) => list.find(e => e.key === key)!;

test('exhibits without their artifact, or with malformed or short data, are unavailable with a reason', () => {
  const list = buildExhibits([art('a', 'financial_analytics', analytics)]);
  assert.deepEqual(list.map(e => e.key), EXHIBITS.map(e => e.key));
  for (const key of ['segment_economics', 'cash_conversion', 'scenario_drivers', 'scenario_values', 'valuation_matrix', 'stress_cases']) {
    const e = byKey(list, key);
    assert.ok(!isAvailable(e), key);
    assert.ok((e as { unavailable: string }).unavailable.trim(), key);
  }
  assert.match((byKey(list, 'cash_conversion') as any).unavailable, /malformed/);
  assert.match((byKey(list, 'scenario_drivers') as any).unavailable, /No stored operating scenarios/);
  assert.ok(isAvailable(byKey(list, 'operating_margin_trend')));
  const short = buildExhibits([art('a', 'financial_analytics', { ...analytics, quarterly: { ...analytics.quarterly, rows: analytics.quarterly.rows.slice(0, 1) } })]);
  assert.match((byKey(short, 'operating_margin_trend') as any).unavailable, /two/);
});

test('building never throws on garbage input', () => {
  for (const input of [[], null, [null], [art('a', 'financial_analytics', null as any)], [art('v', 'valuation_scenario_set', { valuation_matrix: 5, stress_cases: 'x' })]])
    assert.equal(buildExhibits(input as any).length, EXHIBITS.length);
});

test('a withheld valuation makes every valuation exhibit unavailable with the withheld reason', () => {
  const withheld = art('v', 'valuation_scenario_set', { valuation_status: 'withheld', terminal_anchor_bear: 0, terminal_anchor_base: 0, terminal_anchor_bull: 0,
    withheld_reason: 'No reliable cash flow forecast.', valuation_matrix: { columns: ['case'], rows: [['base']] } });
  const list = buildExhibits([withheld]);
  for (const key of ['scenario_values', 'valuation_bridge', 'valuation_matrix', 'sensitivity_grid', 'stress_cases'])
    assert.equal((byKey(list, key) as any).unavailable, 'No reliable cash flow forecast.', key);
});

test('cells are formatted by kind: currency millions, percent, multiples, negatives, missing values', () => {
  const list = buildExhibits([art('a', 'financial_analytics', analytics)]);
  const q = byKey(list, 'quarterly_results') as BuiltExhibit;
  assert.deepEqual(q.table.columns.map(c => c.label), ['Quarter', 'Revenue', 'Revenue YoY', 'Operating income', 'Gross margin', 'Operating margin', 'FCF margin']);
  assert.deepEqual(q.table.rows[0], ['2024Q1', '1,234.6', '—', '-50', '50.0%', '0.0%', '10.0%']);
  assert.match(q.caption, /EUR millions/);
  const stats = byKey(list, 'history_statistics') as BuiltExhibit;
  assert.deepEqual(stats.table.rows[0], ['Capex to D&A', '1.3x', '1.0x', '2.0x', '1.5x', '50.0%']);
  const capital = byKey(list, 'capital_allocation') as BuiltExhibit;
  assert.deepEqual(capital.table.rows[0], ['2024Q3', '-1,234,567.9']);
  assert.equal(label('nwc_to_revenue'), 'NWC to revenue');
});

test('the newest artifact of a type wins', () => {
  const old = art('old', 'financial_analytics', analytics, 1);
  const fresh = art('new', 'financial_analytics', { ...analytics, currency: 'GBP' }, 2);
  for (const input of [[old, fresh], [fresh, old]])
    assert.match((byKey(buildExhibits(input), 'quarterly_results') as BuiltExhibit).caption, /GBP millions/);
});

const built = (key: string): BuiltExhibit => ({ key: key as any, title: key, caption: '', home: EXHIBITS.find(e => e.key === key)!.home, kind: 'table', table: { columns: [], rows: [] }, notes: [] });

test('placement uses fallbacks in order, skips conclusion chapters and unavailable exhibits', () => {
  const exhibits: Exhibit[] = [built('quarterly_results'), built('cash_conversion'), built('stress_cases'), { key: 'segment_economics', title: 's', home: 'business', unavailable: 'none' }];
  const placed = placeExhibits([
    { id: 'verdict', coverage: ['conclusion', 'history', 'business'] },
    { id: 'team', coverage: ['management'] },
    { id: 'value', coverage: ['valuation'] },
  ], exhibits);
  assert.deepEqual(placed, { verdict: [], team: ['cash_conversion'], value: ['stress_cases'] });
});

const doc = (standard: string, sections: any[]): ReportDocument => ({
  asset_name: 'Example', cutoff: '2025-01-01T00:00:00.000Z', is_test: false, required_coverage: [], coverage: [], questions: [], evidence: [],
  artifacts: [art('a', 'financial_analytics', analytics)], sections, standard_version: standard, input_hash: 'x', content_hash: 'y',
  conclusion_status: 'ready_for_review', markdown: '',
});

test('chapterExhibits returns a chapter\'s built exhibits in stored order, skipping unknown, unavailable and repeated keys', () => {
  const d = doc(EXHIBIT_STANDARD, [{ id: 'history', exhibits: ['operating_margin_trend', 'nope', 'cash_conversion', 'quarterly_results', 'operating_margin_trend'] }, { id: 'plain' }]);
  assert.deepEqual(chapterExhibits(d, 'history').map(e => e.key), ['operating_margin_trend', 'quarterly_results']);
  assert.deepEqual(chapterExhibits(d, 'plain'), []);
  assert.deepEqual(chapterExhibits(d, 'missing'), []);
  assert.deepEqual(chapterExhibits(doc('asset-framework-2.1-adaptive-2', d.sections), 'history'), []);
});

test('the exhibits module stays client-safe: no Node, database or server-only imports', () => {
  const source = readFileSync(new URL('../src/lib/research/reporting/exhibits.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*from\s+'([^']+)'/gm)].filter(m => !m[1]).map(m => m[2]);
  assert.deepEqual(imports.sort(), ['../valuation/contracts', './visuals']);
});
