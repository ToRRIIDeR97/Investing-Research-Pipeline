import test from 'node:test';
import assert from 'node:assert/strict';
import { basisClass, forecastTableRows, kpiCandidateKeys, kpiSeries, parseUnit } from '../src/lib/research/reporting/dashboard-series';

const q = (metric_key: string, fiscal_year: number, fiscal_quarter: number, value_numeric: number | null, extra: Record<string, any> = {}) =>
  ({ metric_key, periodicity: 'quarterly', fiscal_year, fiscal_quarter, value_numeric, unit: 'USD', currency: 'USD', reporting_basis: 'gaap', segment: null, geography: null, ...extra });
const millions = { unit: 'USD_millions', reporting_basis: 'as_reported' };
const values = (series: ReturnType<typeof kpiSeries>) => series.points.map(p => [p.period, p.value]);

test('Basis and unit labels are compared by meaning and raw USD is shown in USD millions', () => {
  assert.equal(basisClass('GAAP as reported'), 'gaap');
  assert.equal(basisClass('GAAP derived quarterly from YTD'), 'gaap');
  assert.equal(basisClass('Non-GAAP company-defined'), 'non_gaap');
  assert.equal(basisClass('as_reported'), null);
  assert.equal(basisClass('as_reported', 'free_cash_flow_company_defined_non_gaap'), 'non_gaap');
  assert.deepEqual(parseUnit('USD_millions'), { base: 'usd', scale: 1e6, currency: true });
  assert.deepEqual(parseUnit('USD'), { base: 'usd', scale: 1, currency: true });
  assert.equal(parseUnit('USD/shares')!.currency, false);

  const item = { kpi: 'Operating cash', metric_key: 'operating_cash_flow', unit: 'USD millions', reporting_basis: 'GAAP derived quarterly from YTD' };
  const series = kpiSeries(item, [q('operating_cash_flow', 2026, 1, 32_226_000_000), q('operating_cash_flow', 2026, 2, 31_862_000_000)], item.metric_key);
  assert.equal(series.reason, '');
  assert.equal(series.unit, 'USD millions');
  assert.deepEqual(values(series), [['2026-Q1', 32226], ['2026-Q2', 31862]]);
});

test('Aliases fill history only where they agree with the KPI key', () => {
  assert.ok(kpiCandidateKeys('total_revenue').includes('revenue'));
  assert.ok(kpiCandidateKeys('income_from_operations_gaap').includes('us_gaap_OperatingIncomeLoss'));
  assert.deepEqual(kpiCandidateKeys('free_cash_flow_company_defined_non_gaap'), ['free_cash_flow_company_defined_non_gaap']);
  const item = { kpi: 'Revenue', metric_key: 'total_revenue', unit: 'USD millions', reporting_basis: 'GAAP as reported' };
  const history = [q('revenue', 2025, 4, 59_893_000_000), q('revenue', 2026, 1, 56_311_000_000), q('revenue', 2026, 2, 60_801_000_000)];
  const series = kpiSeries(item, [q('total_revenue', 2026, 2, 60801, millions), ...history], item.metric_key);
  assert.deepEqual(series.keys, ['total_revenue', 'revenue']);
  assert.deepEqual(values(series), [['2025-Q4', 59893], ['2026-Q1', 56311], ['2026-Q2', 60801]]);
  assert.equal(series.rows.at(-1)!.metric_key, 'total_revenue');

  const conflicting = kpiSeries(item, [q('total_revenue', 2026, 2, 61000, millions), q('total_revenue', 2026, 1, 56311, millions), ...history], item.metric_key);
  assert.deepEqual(conflicting.keys, ['total_revenue']);
  assert.deepEqual(values(conflicting), [['2026-Q1', 56311], ['2026-Q2', 61000]]);
});

test('Segment KPIs use segment rows or segment-named keys, never the consolidated series', () => {
  const item = { kpi: 'Family of Apps revenue', metric_key: 'family_of_apps_revenue', unit: 'USD millions', reporting_basis: 'GAAP segment as reported', segment: 'Family of Apps' };
  const rows = [
    q('family_of_apps_revenue', 2026, 2, 60370, millions),
    q('family_of_apps_revenue_gaap', 2026, 1, 55909, { unit: 'USD millions', reporting_basis: 'as_reported' }),
    q('revenue', 2025, 4, 59_893_000_000),
  ];
  assert.deepEqual(values(kpiSeries(item, rows, item.metric_key)), [['2026-Q1', 55909], ['2026-Q2', 60370]]);

  const consolidatedOnly = kpiSeries({ ...item, metric_key: 'revenue' }, [q('revenue', 2026, 1, 1e9), q('revenue', 2026, 2, 2e9)], 'revenue');
  assert.match(consolidatedOnly.reason, /different segment/);
  const dimensioned = kpiSeries({ ...item, metric_key: 'revenue' }, [q('revenue', 2026, 1, 1e9, { segment: 'meta:FamilyOfAppsMember' }), q('revenue', 2026, 2, 2e9, { segment: 'meta:FamilyOfAppsMember' })], 'revenue');
  assert.deepEqual(values(dimensioned), [['2026-Q1', 1000], ['2026-Q2', 2000]]);
  const consolidatedItem = kpiSeries({ kpi: 'Revenue', metric_key: 'revenue', unit: 'USD millions' }, [q('revenue', 2026, 1, 1e9, { segment: 'meta:FamilyOfAppsMember' }), q('revenue', 2026, 2, 2e9, { segment: 'meta:FamilyOfAppsMember' })], 'revenue');
  assert.notEqual(consolidatedItem.reason, '');
});

test('KPI series reject other bases, year-to-date rows and ambiguous periods, and keep gaps', () => {
  const fcf = { kpi: 'FCF', metric_key: 'free_cash_flow_company_defined_non_gaap', unit: 'USD millions', reporting_basis: 'Non-GAAP company-defined' };
  const fcfRows = [q(fcf.metric_key, 2024, 3, 15522, millions), q(fcf.metric_key, 2025, 3, 10625, millions)];
  assert.deepEqual(values(kpiSeries(fcf, fcfRows, fcf.metric_key)).map(([p, v]) => v), [15522, null, null, null, 10625]);
  assert.notEqual(kpiSeries({ ...fcf, reporting_basis: 'GAAP as reported' }, fcfRows, fcf.metric_key).reason, '');

  const capex = { kpi: 'Capex', metric_key: 'us_gaap_PaymentsToAcquirePropertyPlantAndEquipment', unit: 'USD millions', reporting_basis: 'GAAP derived quarterly from YTD' };
  const ytd = q(capex.metric_key, 2026, 2, 49_113_000_000, { period_start: '2026-01-01', period_end: '2026-06-30' });
  const single = kpiSeries(capex, [q(capex.metric_key, 2026, 1, 18_997_000_000), ytd], capex.metric_key);
  assert.match(single.reason, /At least two/);
  assert.deepEqual(values(single), [['2026-Q1', 18997]]);

  const net = { kpi: 'Net income', metric_key: 'net_income', unit: 'USD millions' };
  const ambiguous = kpiSeries(net, [q('net_income', 2026, 1, 1e9), q('net_income', 2026, 1, 2e9, { unit: 'USD millions', currency: 'USD', value_numeric: 2000 }), q('net_income', 2026, 2, 3e9)], 'net_income');
  assert.match(ambiguous.reason, /conflicting/);
  assert.match(kpiSeries(net, [], null).reason, /No captured metric/);
});

test('Forecast tables keep values already in millions and convert only raw amounts', () => {
  const projections = [
    { fiscal_year: 2026, operating_values: { base_capex: 120464, revenue: 2_000_000_000, operating_margin: 0.31, eps: 7.2 },
      balance_sheet_values: { diluted_shares: 2_566_000_000, diluted_shares_millions: 2566, shares_outstanding_millions: 2566, net_debt_usd_millions: 83664 },
      per_share_values: { base_price_target: 433.6 } },
    { fiscal_year: 2027, operating_values: { base_capex: 130000, revenue: 2_300_000_000, operating_margin: 31.5, eps: 8 },
      balance_sheet_values: { diluted_shares: 2_566_000_000, diluted_shares_millions: 2566, shares_outstanding_millions: 2566 },
      per_share_values: { base_price_target: 496.3 } },
  ];
  assert.deepEqual(forecastTableRows(projections, 'operating_values'), [
    ['Base capex (USD millions)', 120464, 130000],
    ['Revenue (USD millions)', 2000, 2300],
    ['Operating margin (%)', 31, 31.5],
    ['Earnings per share (USD/share)', 7.2, 8],
  ]);
  assert.deepEqual(forecastTableRows(projections, 'balance_sheet_values'), [
    ['Diluted shares (million shares)', 2566, 2566],
    ['Shares outstanding millions (million shares)', 2566, 2566],
    ['Net debt USD millions (USD millions)', 83664, null],
  ]);
  assert.deepEqual(forecastTableRows(projections, 'per_share_values', 'EUR'), [['Base price target (EUR/share)', 433.6, 496.3]]);
});
