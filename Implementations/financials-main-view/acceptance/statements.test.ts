import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as presentation from '../../../src/lib/research/reporting/presentation.mjs';

function model(rows: any[], frequency = 'quarterly') {
  const build = (presentation as any).financialStatements;
  assert.equal(typeof build, 'function', 'AC-2: export financialStatements from the existing presentation module');
  return build(rows, frequency);
}
const row = (metric_key: string, value_numeric: number | null, extra = {}) => ({
  metric_key, value_numeric, unit: 'USD', currency: 'USD', periodicity: 'quarterly',
  reporting_basis: 'gaap', fiscal_year: 2026, fiscal_quarter: 2, ...extra,
});

test('AC-3: existing history formatting distinguishes zero, null and exact amounts', () => {
  const matrix = presentation.historyMatrix([
    row('loan_loss_reserve', 0, { fiscal_quarter: 1 }),
    row('loan_loss_reserve', null),
    row('loan_loss_reserve', 56459000, { fiscal_quarter: 3 }),
  ]);
  assert.deepEqual(matrix.periods, ['Q1 2026', 'Q2 2026', 'Q3 2026']);
  assert.deepEqual(matrix.rows[0].values, ['0', 'Not disclosed', '56.459']);
  assert.equal(matrix.rows[0].exact[2], '56,459,000 USD');
});

test('AC-2/3: selected SoFi history is partitioned losslessly into statements', () => {
  const rows = JSON.parse(readFileSync(new URL('../fixtures/sofi-observations.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(rows);
  const result = model(rows);
  const classified = [...result.income, ...result.balance, ...result.cashflow, ...result.other];
  assert.deepEqual(classified.map((r: any) => JSON.stringify(r)).sort(), rows.filter((r: any) => r.periodicity === 'quarterly').map((r: any) => JSON.stringify(r)).sort());
  assert.ok(result.income.some((r: any) => r.metric_key === 'net_revenue'));
  assert.ok(result.balance.some((r: any) => r.metric_key === 'loan_loss_reserve'));
  assert.ok(result.cashflow.some((r: any) => r.metric_key === 'operating_cash_flow'));
  assert.deepEqual(result.missingCashFlows, ['investing_cash_flow', 'financing_cash_flow']);
  assert.equal(JSON.stringify(rows), before);
  const matrix = presentation.historyMatrix(result.balance);
  const reserve = matrix.rows.find((r: any) => r.name === 'Loan loss reserve');
  const period = matrix.periods.indexOf('Q2 2026');
  assert.equal(reserve.values[period], '56.459');
  assert.equal(reserve.exact[period], '56,459,000 USD');
});

test('AC-3/4: zero is available; unknown items remain accessible; no annual synthesis', () => {
  const rows = [row('operating_cash_flow', 0), row('investing_cash_flow', null), row('financing_cash_flow', -8), row('customer_count', 12)];
  const result = model(rows);
  assert.deepEqual(result.missingCashFlows, ['investing_cash_flow']);
  assert.equal(result.cashflow.find((r: any) => r.metric_key === 'operating_cash_flow').value_numeric, 0);
  assert.deepEqual(result.other, [rows[3]]);
  const annual = model(rows, 'annual');
  assert.equal([...annual.income, ...annual.balance, ...annual.cashflow, ...annual.other].length, 0);
});

test('AC-2/4: explicit statement categories classify unfamiliar metrics without mixing frequencies', () => {
  const rows = [row('custom_expense', 6, { metadata_json: { metric_category: 'income_statement' } }), row('total_assets', 40, { periodicity: 'annual', fiscal_quarter: null })];
  assert.deepEqual(model(rows).income, [rows[0]]);
  assert.deepEqual(model(rows, 'annual').balance, [rows[1]]);
});
