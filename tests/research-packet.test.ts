import assert from 'node:assert/strict';
import test from 'node:test';
import { researchPacketForModel } from '../src/lib/research/reporting/packet';

test('financial request tables preserve all periods, values, units, bases, dimensions and provenance without mutating artifacts', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ metric_key: 'net_revenue',
    fiscal_year: 2000 + Math.floor(index / 4), fiscal_quarter: index % 4 + 1,
    value_numeric: index === 0 ? null : index - 2, unit: 'USD', currency: 'USD',
    reporting_basis: index % 2 ? 'gaap' : 'adjusted', periodicity: 'quarterly',
    comparability_status: 'comparable', source_document_id: 'source-one', evidence_claim_id: 'claim-one',
    available_at: '2026-01-01', formula_or_adjustment: 'reported',
    metadata_json: { dimensions: { segment: 'Lending' }, statement_label: 'Net revenue',
      metric_category: 'income_statement', raw_extraction: 'audit data '.repeat(100) } }));
  const packet = { cutoff: new Date('2026-01-01T00:00:00Z'), artifacts: [{ id: 'artifact-one', content_json: { artifact_type: 'historical_record',
    observations: rows, ttm_series: [], reconciliation_issues: [{ severity: 'blocking', description: 'Unreconciled' }] } }] };
  const before = JSON.stringify(packet);
  const view = researchPacketForModel(packet);
  const history = view.artifacts[0].content_json;
  const table = history.observations;
  const decoded: any[] = [];
  for (const group of table.series) for (const row of group.rows) {
    const fields = Object.fromEntries(table.row_columns.map((key: string, i: number) => [key, row[i]]));
    const source = Object.fromEntries(table.source_columns.map((key: string, i: number) => [key, table.sources[fields.source_index][i]]));
    decoded[fields.observation_index] = { ...group.fields, ...fields, ...source };
  }
  assert.equal(decoded.length, rows.length);
  rows.forEach((row, i) => {
    for (const [key, value] of Object.entries(row)) if (key !== 'metadata_json') assert.deepEqual(decoded[i][key], value);
    assert.deepEqual(decoded[i].dimensions, row.metadata_json.dimensions);
    assert.equal(decoded[i].statement_label, row.metadata_json.statement_label);
  });
  assert.equal(table.canonical_table_path, 'observations');
  assert.deepEqual(history.reconciliation_issues, packet.artifacts[0].content_json.reconciliation_issues);
  assert.equal(view.artifacts[0].id, 'artifact-one');
  assert.equal(view.cutoff.toISOString(), packet.cutoff.toISOString());
  assert.equal(JSON.stringify(packet), before);
  assert.ok(JSON.stringify(view).length < before.length / 4);
  assert.deepEqual(researchPacketForModel(view), view, 'Reusing an encoded view must be idempotent');
});
