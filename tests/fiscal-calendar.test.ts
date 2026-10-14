import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fiscalLabel, fiscalPeriodsFromObservations } from '../src/lib/research/history/fiscal-calendar';

// A June fiscal year (Microsoft-style): FY2024 Q1 is Jul-Sep 2023, Q4 is Apr-Jun 2024.
const juneFiling = [
  { metric_key: 'net_revenue', periodicity: 'quarterly', period_end: '2023-09-30', fiscal_year: 2024, fiscal_quarter: 1 },
  { metric_key: 'net_revenue', periodicity: 'quarterly', period_end: '2023-12-31', fiscal_year: 2024, fiscal_quarter: 2 },
  { metric_key: 'net_revenue', periodicity: 'quarterly', period_end: '2024-03-31', fiscal_year: 2024, fiscal_quarter: 3 },
  { metric_key: 'total_assets', periodicity: 'quarterly', period_end: '2024-06-30', fiscal_year: 2024, fiscal_quarter: 4 },
  { metric_key: 'net_revenue', periodicity: 'annual', period_end: '2024-06-30', fiscal_year: 2024, fiscal_quarter: null },
  // Headcount rows are placed on the calendar, not a source of it.
  { metric_key: 'employees', periodicity: 'quarterly', period_end: '2024-05-15', fiscal_year: 2024, fiscal_quarter: 4 },
];

test('fiscal periods come from filed quarterly rows, one per date, without headcount', () => {
  const periods = fiscalPeriodsFromObservations(juneFiling);
  assert.deepEqual(periods.map(p => p.end), ['2023-09-30', '2023-12-31', '2024-03-31', '2024-06-30']);
});

test('June fiscal year: companyfacts quarters take the filing fiscal labels, not calendar ones', () => {
  const periods = fiscalPeriodsFromObservations(juneFiling);
  // A known period end.
  assert.deepEqual(fiscalLabel('2023-07-01', '2023-09-30', periods), { fiscal_year: 2024, fiscal_quarter: 1, periodicity: 'quarterly' });
  // Jan-Mar 2024 is fiscal 2024Q3, not calendar 2024Q1.
  assert.deepEqual(fiscalLabel('2024-01-01', '2024-03-31', periods), { fiscal_year: 2024, fiscal_quarter: 3, periodicity: 'quarterly' });
  // Quarters outside the filings' window are placed on the same grid.
  assert.deepEqual(fiscalLabel('2022-04-01', '2022-06-30', periods), { fiscal_year: 2022, fiscal_quarter: 4, periodicity: 'quarterly' });
  assert.deepEqual(fiscalLabel('2024-07-01', '2024-09-30', periods), { fiscal_year: 2025, fiscal_quarter: 1, periodicity: 'quarterly' });
  // A balance (no start) at a fiscal quarter end.
  assert.deepEqual(fiscalLabel(null, '2023-12-31', periods), { fiscal_year: 2024, fiscal_quarter: 2, periodicity: 'quarterly' });
  // The fiscal year ends in June.
  assert.deepEqual(fiscalLabel('2023-07-01', '2024-06-30', periods), { fiscal_year: 2024, fiscal_quarter: null, periodicity: 'annual' });
});

test('rows off the fiscal grid or a long period not ending a fiscal year are unlabelled', () => {
  const periods = fiscalPeriodsFromObservations(juneFiling);
  // A calendar year ending in December does not end a June fiscal year.
  assert.equal(fiscalLabel('2023-01-01', '2023-12-31', periods), null);
  // Mid-quarter date.
  assert.equal(fiscalLabel(null, '2023-11-15', periods), null);
});

test('52/53-week September fiscal year: quarters ending on Saturdays are placed', () => {
  const periods = fiscalPeriodsFromObservations([
    { metric_key: 'net_revenue', periodicity: 'quarterly', period_end: '2024-09-28', fiscal_year: 2024, fiscal_quarter: 4 },
    { metric_key: 'net_revenue', periodicity: 'quarterly', period_end: '2024-12-28', fiscal_year: 2025, fiscal_quarter: 1 },
  ]);
  assert.deepEqual(fiscalLabel('2024-03-31', '2024-06-29', periods), { fiscal_year: 2024, fiscal_quarter: 3, periodicity: 'quarterly' });
  assert.deepEqual(fiscalLabel('2023-10-01', '2024-09-28', periods), { fiscal_year: 2024, fiscal_quarter: null, periodicity: 'annual' });
  assert.deepEqual(fiscalLabel('2022-06-26', '2022-09-24', periods), { fiscal_year: 2022, fiscal_quarter: 4, periodicity: 'quarterly' });
});

test('with no filed periods, rows keep calendar labels', () => {
  assert.deepEqual(fiscalLabel('2024-01-01', '2024-03-31', []), { fiscal_year: 2024, fiscal_quarter: 1, periodicity: 'quarterly' });
  assert.deepEqual(fiscalLabel('2024-01-01', '2024-12-31', []), { fiscal_year: 2024, fiscal_quarter: null, periodicity: 'annual' });
});
