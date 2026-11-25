import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChart, parseSumKey, sumKey, summedSeries } from '../src/lib/research/reporting/chart-series';
import { MetricBook, type PeriodRef } from '../src/lib/research/reporting/metric-catalogue';
import { savedChartDefinition } from '../src/lib/research/reporting/saved-charts';
import { changeTone, formatAmount, formatChange, matches, priorYearLabel, statementTree, unitKind, yearChange, type TreeInput } from '../src/components/financials/statement-rows';

type Row = Record<string, any>;
const P: PeriodRef[] = [{ year: 2026, quarter: 1 }, { year: 2026, quarter: 2 }, { year: 2026, quarter: 3 }];
const row = (metric_key: string, quarter: number, value: number, unit = 'USD'): Row => ({
  metric_key, value_numeric: value, unit, currency: unit === 'USD' ? 'USD' : null, periodicity: 'quarterly', fiscal_year: 2026, fiscal_quarter: quarter,
  metadata_json: { statement: 'income', statement_label: metric_key === 'sm' ? 'Sales and marketing' : metric_key },
});
const observations = [
  row('sm', 1, 300e6), row('sm', 2, 390e6), row('sm', 3, 440e6),
  row('ga', 1, 200e6), row('ga', 2, 210e6),
  row('rebate', 1, 50e6), row('rebate', 2, 40e6), row('rebate', 3, 30e6),
  row('shares_out', 1, 1e9, 'shares'),
];
const book = new MetricBook(observations, 'quarterly');

test('sum keys round-trip and reject anything else', () => {
  const key = sumKey([{ key: 'sm', sign: 1 }, { key: 'rebate', sign: -1 }, { key: 'metric:gross_profit', sign: 1 }]);
  assert.equal(key, 'sum:+sm-rebate+metric:gross_profit');
  assert.deepEqual(parseSumKey(key)?.map((t) => [t.key, t.sign]), [['sm', 1], ['rebate', -1], ['metric:gross_profit', 1]]);
  assert.equal(parseSumKey('sum:+sm'), null, 'one term is not a sum');
  assert.equal(parseSumKey('sum:+sm+sm'), null, 'a term appears once');
  assert.equal(parseSumKey('sum:+sm;drop'), null);
  assert.equal(parseSumKey('sum:sm+ga'), null, 'every term carries a sign');
  assert.equal(parseSumKey('revenue'), null);
});

test('a summed series adds and subtracts per period and leaves a gap when a part is missing', () => {
  const s = summedSeries(observations, 'quarterly', 'sum:+sm+ga-rebate', P, book, 'Opex net');
  assert.equal(s.reason, null);
  assert.equal(s.label, 'Opex net');
  assert.deepEqual(s.values, [450e6, 560e6, null]);
  assert.equal(summedSeries(observations, 'quarterly', 'sum:+sm-rebate', P, book).label, 'Sales and marketing − rebate');
  assert.match(summedSeries(observations, 'quarterly', 'sum:+sm+shares_out', P, book).reason ?? '', /different units/);
  assert.match(summedSeries(observations, 'quarterly', 'sum:+sm+missing_line', P, book).reason ?? '', /missing_line|not captured/i);
});

test('buildChart charts a summed series under its own name', () => {
  const chart = buildChart({ observations, frequency: 'quarterly', book, periods: P, specs: [{ key: 'sum:+sm+ga', as: 'bar', label: 'Opex' }] });
  assert.equal(chart.series[0].label, 'Opex');
  assert.deepEqual(chart.series[0].values, [500e6, 600e6, null]);
});

test('saved bundles accept sum keys with a plain-text label', () => {
  const base = { chart_type: 'bars', frequency: 'quarterly', range: 'last_8', mode: 'values' } as const;
  const ok = savedChartDefinition.safeParse({ ...base, series: [{ key: 'sum:+sm-rebate', as: 'bar', axis: 'left', label: '  Opex\u0000 net ' }] });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.series[0].label, 'Opex net');
  assert.equal(savedChartDefinition.safeParse({ ...base, series: [{ key: 'sum:+sm', as: 'bar', axis: 'left' }] }).success, false);
  assert.equal(savedChartDefinition.safeParse({ ...base, series: [{ key: 'sum:+sm-<x>', as: 'bar', axis: 'left' }] }).success, false);
  assert.equal(savedChartDefinition.safeParse({ ...base, series: [{ key: 'sm', as: 'bar', axis: 'left', label: 'x'.repeat(81) }] }).success, false);
});

// A bank income statement as filed: parts before their totals, two lines filed out of place at the
// bottom (corporate borrowings, cost of operations), USD millions over four quarters.
const M = 1e6;
const line = (key: string, name: string, v: (number | null)[]): TreeInput => ({ key, name, unit: 'currency|USD', values: v.map((x) => (x === null ? null : x * M)) });
const filed: TreeInput[] = [
  line('loans', 'Loans', [688.7, 712.9, 738.9, 830.2]),
  line('other_ii', 'Other', [55.2, 50.9, 53.5, 61.4]),
  line('tii', 'Total interest income', [743.9, 763.8, 792.4, 891.6]),
  line('wh', 'Securitizations and warehouses', [23.0, 28.1, 29.7, 29.8]),
  line('dep', 'Deposits', [238.6, 225.4, 233.2, 264.9]),
  line('other_ie', 'Other', [0.1, 0.1, 0.2, 0.1]),
  line('net_interest_income', 'Net interest income', [470.1, 498.7, 517.8, 585.1]),
  line('fees', 'Loan platform fees', [63.2, 92.8, 127.4, 164.9]),
  line('tech', 'Technology products and solutions', [88.4, 86.4, 90.8, 89.7]),
  line('tnii', 'Total noninterest income', [151.6, 179.2, 218.2, 254.6]),
  line('net_revenue', 'Total net revenue', [621.7, 677.9, 736.0, 839.7]),
  line('sm', 'Sales and marketing', [229.3, 238.2, 264.7, 286.9]),
  line('ga', 'General and administrative', [160.9, 156.4, 165.4, 188.4]),
  line('opex', 'Total noninterest expense', [518.4, 530.1, 580.5, 636.7]),
  line('pretax', 'Income before income taxes', [103.3, 147.8, 155.5, 203.0]),
  line('tax', 'Income tax expense', [-272.5, 8.7, 14.9, 9.2]),
  line('net_income', 'Net income', [375.8, 139.1, 140.6, 193.8]),
  line('corp', 'Corporate borrowings', [12.0, 11.4, 11.5, 11.6]),
  line('ops', 'Cost of operations', [128.2, 135.5, 150.4, 161.4]),
  line('tie', 'Total interest expense', [273.7, 265.0, 274.6, 306.4]),
];
const nameAt = (i: number) => filed[i].key;

test('statement tree: totals above the lines that add up to them, revenue first', () => {
  const tree = statementTree(filed);
  const shown = tree.order.map((i) => `${'  '.repeat(tree.depth[i])}${nameAt(i)}`);
  assert.deepEqual(shown, [
    'net_revenue',
    '  net_interest_income',
    '    tii', '      loans', '      other_ii',
    '    tie', '      wh', '      dep', '      other_ie', '      corp',
    '  tnii', '    fees', '    tech',
    'opex', '  sm', '  ga', '  ops',
    'pretax', 'tax', 'net_income',
  ]);
});

test('statement tree: a coincidence in one quarter is not a part, and segments never nest', () => {
  const rows: TreeInput[] = [
    line('a', 'Product', [100, 110, 120, 130]),
    line('b', 'Services', [50, 55, 60, 65]),
    line('odd', 'One-off gain', [150, null, null, null]),
    { ...line('seg', 'Total', [150, 165, 180, 195]), segment: true },
    line('rev', 'Total revenue', [150, 165, 180, 195]),
  ];
  const tree = statementTree(rows);
  assert.deepEqual(tree.children[4], [0, 1]);
  assert.equal(tree.parent[2], null, 'reported in one quarter of four');
  assert.equal(tree.parent[3], null);
  assert.deepEqual(statementTree([line('x', 'Total costs', [10, 20, 30]), line('y', 'Rent', [4, 9, 15])]).children[0], [], 'nothing adds up: flat');
  const balance = statementTree([line('total_liabilities', 'Total liabilities', [80, 90, 95]), line('stockholders_equity', 'Total equity', [20, 25, 30]), line('total_assets', 'Total assets', [100, 115, 125])]);
  assert.deepEqual(balance.children[2], [], 'liabilities and equity are not parts of assets');
});

test('statement numbers: one decimal in millions, shares in millions, per share to the cent', () => {
  assert.equal(unitKind('USD', 'USD'), 'currency');
  assert.equal(unitKind('USD/shares', null), 'per_share');
  assert.equal(unitKind('shares', null), 'shares');
  assert.equal(formatAmount(688_723_000, 'currency'), '688.7');
  assert.equal(formatAmount(-1_305_874_000, 'currency'), '−1,305.9');
  assert.equal(formatAmount(1_292_541_000, 'shares'), '1,292.5M');
  assert.equal(formatAmount(0.185, 'per_share'), '0.19');
});

test('change on a year earlier, and whether it is good news', () => {
  assert.equal(priorYearLabel('Q3 2026'), 'Q3 2025');
  assert.equal(priorYearLabel('2026'), '2025');
  assert.equal(priorYearLabel('Period unavailable'), '');
  assert.equal(yearChange(150, 100), 0.5);
  assert.equal(yearChange(-50, -100), 0.5, 'a smaller loss is an improvement');
  assert.equal(yearChange(10, 0), null);
  assert.equal(yearChange(null, 10), null);
  assert.equal(changeTone('Total net revenue', 0.2), 'good');
  assert.equal(changeTone('Sales and marketing', 0.2), 'good', 'alone, an unknown line reads up = good');
  assert.equal(changeTone('Sales and marketing', 0.2, 'Total noninterest expense'), 'bad');
  assert.equal(changeTone('Deposits', 0.2, 'Total interest expense'), 'bad');
  assert.equal(changeTone('Loan platform fees', 0.2, 'Total noninterest income'), 'good');
  assert.equal(changeTone('Interest income on loans', 0.2, 'Total expense'), 'good');
  assert.equal(changeTone('Provision for credit losses', -0.1), 'good');
  assert.equal(changeTone('Net loss', 0.3), 'good', 'filed as "Net loss" but a profit line');
  assert.equal(changeTone('Loss per share – basic', 0.3), 'good');
  assert.equal(changeTone('Revenue', 0.001), null);
  assert.equal(formatChange(0.444), '+44%');
  assert.equal(formatChange(-0.31), '−31%');
  assert.equal(formatChange(25), '+999+%');
});

test('command bar matches words in any order', () => {
  assert.equal(matches('Sales and marketing', 'sales market'), true);
  assert.equal(matches('Sales and marketing', 'market sales'), true);
  assert.equal(matches('Total noninterest expense', 'total nonint exp'), true);
  assert.equal(matches('Deposits', 'cash'), false);
});

test('raw XBRL tags read as plain words; real labels pass through', async () => {
  const { lineName } = await import('../src/lib/research/reporting/presentation.mjs');
  assert.equal(lineName('us-gaap:TemporaryEquityCarryingAmountAttributableToParent'), 'Temporary equity carrying amount attributable to parent');
  assert.equal(lineName('us-gaap:OtherAssets'), 'Other assets');
  assert.equal(lineName('sofi:LoanPlatformFeesNet'), 'Loan platform fees net');
  assert.equal(lineName('us-gaap:EBITDAAdjusted'), 'EBITDA adjusted');
  assert.equal(lineName('Total net revenue'), 'Total net revenue');
  assert.equal(lineName('Debt(1)'), 'Debt(1)');
});
