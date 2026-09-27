import test from 'node:test';
import assert from 'node:assert/strict';
import * as presentation from '../../../src/lib/research/reporting/presentation.mjs';

function model(rows: any[], frequency = 'quarterly') {
  const build = (presentation as any).financialStatements;
  assert.equal(typeof build, 'function', 'AC-2: financial statement presentation behavior is not implemented');
  return build(rows, frequency);
}
const base = { metric_key: 'total_assets', unit: 'USD', currency: 'USD', periodicity: 'quarterly', reporting_basis: 'gaap', fiscal_year: 2026, fiscal_quarter: 1, value_numeric: 7000000 };

test('AC-2/3: mixed currencies, segments, bases and duplicate observations survive grouping', () => {
  const rows = [base, { ...base, currency: 'EUR', unit: 'EUR', value_numeric: 9000000 }, { ...base, segment: 'consumer', value_numeric: 1000000 }, { ...base, reporting_basis: 'adjusted', value_numeric: 2000000 }, { ...base, value_numeric: 8000000 }];
  const result = model(rows);
  assert.deepEqual(result.balance, rows);
  const matrix = presentation.historyMatrix(result.balance);
  assert.equal(matrix.rows.length, 4);
  assert.ok(matrix.rows.some((r: any) => r.values[0] === '7 / 8'));
  assert.ok(matrix.rows.some((r: any) => r.unit === 'EUR millions' && r.values[0] === '9'));
});

test('AC-3/4: empty and annual-only inputs stay empty in the quarterly view', () => {
  for (const input of [[], [{ ...base, periodicity: 'annual', fiscal_quarter: null }]]) {
    const result = model(input);
    assert.deepEqual([result.income, result.balance, result.cashflow, result.other], [[], [], [], []]);
    assert.deepEqual(result.missingCashFlows, ['operating_cash_flow', 'investing_cash_flow', 'financing_cash_flow']);
  }
});

test('AC-2/3: category metadata and aliases preserve provenance without mutation', () => {
  const rows = [
    { ...base, metric_key: 'total_deposits', source_document_id: 'source-a', metadata_json: { metric_category: 'financial' } },
    { ...base, metric_key: 'noninterest_income_gaap', evidence_claim_id: 'evidence-a' },
    { ...base, metric_key: 'unusual_cash_item', metadata_json: { metric_category: 'cash_flow' }, value_numeric: null },
    { ...base, metric_key: 'unclassified_ratio', unit: 'percent', currency: null },
  ];
  const before = JSON.stringify(rows);
  const result = model(rows);
  assert.deepEqual(result.balance, [rows[0]]);
  assert.deepEqual(result.income, [rows[1]]);
  assert.deepEqual(result.cashflow, [rows[2]]);
  assert.deepEqual(result.other, [rows[3]]);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(presentation.historyMatrix(result.cashflow).rows[0].values[0], 'Not disclosed');
});
