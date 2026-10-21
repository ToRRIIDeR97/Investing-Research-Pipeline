import assert from 'node:assert/strict';
import test from 'node:test';
import { researchPacketForModel } from '../src/lib/research/reporting/packet';

test('model packets carry a small historical_record view instead of raw observations, without mutating artifacts', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ metric_key: index < 60 ? 'net_revenue' : 'net_income',
    fiscal_year: 2000 + Math.floor(index / 4), fiscal_quarter: index % 4 + 1,
    value_numeric: index === 0 ? null : index - 2, unit: 'USD', currency: 'USD', segment: null,
    reporting_basis: 'gaap', periodicity: index % 10 === 9 ? 'annual' : 'quarterly',
    source_document_id: 'source-one', metadata_json: { statement_label: 'Net revenue', raw_extraction: 'audit data '.repeat(100) } }));
  const issues = [{ severity: 'blocking', description: 'Unreconciled' }];
  const packet = { cutoff: new Date('2026-01-01T00:00:00Z'), artifacts: [{ id: 'artifact-one', content_json: { artifact_type: 'historical_record',
    asset_id: 'asset-one', observations: rows, ttm_series: [], reconciliation_issues: issues,
    coverage: { start_fiscal_year: 2020, start_fiscal_quarter: 1, end_fiscal_year: 2024, end_fiscal_quarter: 4, quarters_required: 20,
      quarters_present: 19, is_complete: false, gaps: [{ why_missing: 'Missing revenue in 2022Q3' }], cells: Array(20).fill({ present: true }) } } }] };
  const before = JSON.stringify(packet);
  const view = researchPacketForModel(packet);
  const history = view.artifacts[0].content_json;
  assert.equal(history.observations, undefined);
  assert.equal(history.observation_count, 100);
  assert.deepEqual(history.reconciliation_issues, { total: 1, blocking: 1, first: issues });
  assert.deepEqual(history.coverage, { start: '2020Q1', end: '2024Q4', quarters_required: 20, quarters_present: 19, is_complete: false,
    gaps: 1, first_gaps: ['Missing revenue in 2022Q3'] });
  const series = history.chart_series.rows.map((row: unknown[]) => Object.fromEntries(history.chart_series.columns.map((c: string, i: number) => [c, row[i]])));
  assert.deepEqual(series.map((s: any) => [s.metric_key, s.quarters, s.first, s.last]),
    [['net_revenue', 53, '2000Q2', '2014Q3'], ['net_income', 36, '2015Q1', '2024Q3']]);
  assert.equal(view.artifacts[0].id, 'artifact-one');
  assert.equal(view.cutoff.toISOString(), packet.cutoff.toISOString());
  assert.equal(JSON.stringify(packet), before);
  assert.ok(JSON.stringify(view).length < before.length / 20);
  assert.deepEqual(researchPacketForModel(view), view, 'Reusing a view must be idempotent');
});
