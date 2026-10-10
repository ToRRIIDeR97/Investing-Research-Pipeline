import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, METRIC_GROUPS, MetricBook, evaluateMetric, formatMetric, metricCatalogue, yearOverYear, type PeriodRef } from '../src/lib/research/reporting/metric-catalogue';
import { buildChart, canAddSeries, niceScale, chartTakeaway, lineItemSeries, toggleSeries, yoySeries } from '../src/lib/research/reporting/chart-series';
import { createSavedChart, savedChartDefinition, updateSavedChart } from '../src/lib/research/reporting/saved-charts';

type Row = Record<string, any>;
// META, Q3 2023 .. Q2 2026, USD millions (shares in millions). Q3 2025 cash-flow lines are left
// out on purpose: the capture only has the FY2025 total for them.
const Q = Array.from({ length: 12 }, (_, i) => ({ year: 2023 + Math.floor((i + 2) / 4), quarter: ((i + 2) % 4) + 1 }));
const D: Record<string, (number | null)[]> = {
  revenue: [34146, 40111, 36455, 39071, 40589, 48385, 42314, 47516, 51242, 59893, 56311, 60801],
  us_gaap_CostOfRevenue: [6210, 7695, 6640, 7308, 7375, 8839, 7572, 8491, 9206, 10906, 10218, 11330],
  us_gaap_OperatingIncomeLoss: [13748, 16384, 13818, 14847, 17350, 23364, 17555, 20441, 20535, 24745, 22872, 18775],
  us_gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: [14020, 16807, 14183, 15106, 17822, 23552, 18382, 20534, 21663, 25354, 21752, 18756],
  us_gaap_IncomeTaxExpenseBenefit: [2437, 2790, 1814, 1641, 2134, 2714, 1738, 2197, 18954, 2586, -5021, 2908],
  net_income: [11583, 14017, 12369, 13465, 15688, 20838, 16644, 18337, 2709, 22768, 26773, 15848],
  us_gaap_DepreciationDepletionAndAmortization: [2859, 3172, 3374, 3637, 4027, 4460, 3900, 4342, null, 5411, 5999, 6356],
  us_gaap_ShareBasedCompensation: [3492, 3424, 3562, 4616, 4250, 4262, 4147, 4834, null, 5890, 6032, 7658],
  operating_cash_flow: [20402, 19404, 19246, 19370, 24724, 27988, 24026, 25561, 29999, 36214, 32226, 31862],
  us_gaap_PaymentsToAcquirePropertyPlantAndEquipment: [6496, 7592, 6400, 8173, 8258, 14425, 12941, 16538, null, 21383, 18997, 30116],
  us_gaap_CashAndCashEquivalentsAtCarryingValue: [36890, 41862, 32307, 32045, 43852, 43889, 28750, 12005, 10187, 35873, 23426, 15462],
  us_gaap_MarketableSecuritiesCurrent: [null, 23541, null, 26035, 27048, 33926, 41480, 35066, 34261, 45719, 57754, 74798],
  total_assets: [216274, 229623, 222844, 230238, 256408, 276054, 280213, 294744, 303844, 366021, 395250, 449956],
  us_gaap_LiabilitiesCurrent: [null, 31960, null, 27004, 33330, 33596, 33890, 37305, 36958, 41836, 46753, 56379],
  us_gaap_LongTermDebtNoncurrent: [null, 18385, null, 18389, 28823, 28826, 28829, 28832, 28834, 58744, 58748, 83664],
  stockholders_equity: [142873, 153168, 149529, 156763, 164529, 182637, 185029, 195070, 194066, 217243, 243681, 261221],
};
const M = 1e6;
const obs = (metric_key: string, value: number, p: PeriodRef, extra: Row = {}): Row => ({
  metric_key, value_numeric: value, fiscal_year: p.year, fiscal_quarter: p.quarter, periodicity: p.quarter ? 'quarterly' : 'annual', unit: 'USD', currency: 'USD',
  reporting_basis: 'as_reported', segment: null, geography: null, metadata_json: { statement: 'income', source_url: 'https://www.sec.gov/Archives/edgar/data/1/x.htm' }, ...extra,
});
const rows: Row[] = Object.entries(D).flatMap(([key, values]) => values.flatMap((v, i) => (v === null ? [] : [obs(key, v * M, Q[i])])));
// FY2025 totals for the lines whose Q3 is missing (Q3 values from the 10-K minus the other quarters).
rows.push(obs('us_gaap_DepreciationDepletionAndAmortization', (3900 + 4342 + 4963 + 5411) * M, { year: 2025, quarter: null }));
rows.push(obs('us_gaap_ShareBasedCompensation', (4147 + 4834 + 5556 + 5890) * M, { year: 2025, quarter: null }));
rows.push(obs('us_gaap_PaymentsToAcquirePropertyPlantAndEquipment', (12941 + 16538 + 18829 + 21383) * M, { year: 2025, quarter: null }));
const Q2_26 = { year: 2026, quarter: 2 };
const metric = (key: string, list = rows, p: PeriodRef = Q2_26) => evaluateMetric(new MetricBook(list, p.quarter ? 'quarterly' : 'annual'), METRICS.find((m) => m.key === key)!, p);
const near = (actual: number | null, expected: number, tolerance = 5e-4) => assert.ok(actual !== null && Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);

test('the catalogue lists the 39 metrics in nine groups with unique keys', () => {
  assert.equal(METRICS.length, 39);
  assert.equal(new Set(METRICS.map((m) => m.key)).size, 39);
  assert.deepEqual([...new Set(METRICS.map((m) => m.group))], [...METRIC_GROUPS]);
  for (const m of METRICS) assert.doesNotMatch(m.name + m.formula, /[a-z]+_[a-z]+/, `${m.key} shows a snake_case key`);
});

test('same-quarter margins match the filed statements, deriving gross profit when it is not reported', () => {
  near(metric('operating_margin').value, 0.3088);
  near(metric('gross_margin').value, 0.8137);
  near(metric('fcf_margin').value, 0.0287);
  near(metric('net_margin').value, 15848 / 60801);
  assert.match(metric('gross_margin').note, /revenue minus cost of revenue/);
  assert.equal(formatMetric(metric('operating_margin').value, 'pct'), '30.9%');
});

test('a missing quarterly flow is the fiscal-year total minus the other quarters, and is flagged', () => {
  const ebitda = metric('ebitda_margin', rows, { year: 2025, quarter: 3 });
  near(ebitda.value, (20535 + 4963) / 51242);
  assert.equal(ebitda.derivedQuarter, true);
  assert.match(ebitda.note, /Depreciation and amortization for Q3 2025 is the FY2025 total minus the other three quarters/);
  assert.equal(metric('operating_margin', rows, { year: 2025, quarter: 3 }).derivedQuarter, false);
});

test('returns use trailing-12-month numerators over averaged balances', () => {
  const roe = metric('roe');
  near(roe.value, (2709 + 22768 + 26773 + 15848) / ((261221 + 195070) / 2));
  assert.equal(roe.inputs[0].basis, 'Trailing 12 months');
  assert.match(roe.inputs[1].basis, /Average/);
  const nopat = [[20535, 18954, 21663], [24745, 2586, 25354], [22872, -5021, 21752], [18775, 2908, 18756]].reduce((s, [o, t, p]) => s + o * (1 - t / p), 0);
  near(metric('roic').value, nopat / ((261221 + 83664 - 15462 - 74798 + 195070 + 28832 - 12005 - 35066) / 2));
  near(metric('roic').value, 0.319, 1e-3);
  near(metric('roce').value, (20535 + 24745 + 22872 + 18775) / ((449956 - 56379 + 294744 - 37305) / 2));
  near(metric('debt_to_ebitda').value, 83664 / (20535 + 24745 + 22872 + 18775 + 4963 + 5411 + 5999 + 6356), 1e-3);
  assert.equal(formatMetric(metric('debt_to_ebitda').value, 'x', 'USD', 2), '0.76×');
});

test('missing inputs stay unavailable and name the input; nothing becomes zero', () => {
  const noCapex = rows.filter((r) => r.metric_key !== 'us_gaap_PaymentsToAcquirePropertyPlantAndEquipment');
  const fcf = metric('fcf_margin', noCapex);
  assert.equal(fcf.value, null);
  assert.equal(fcf.missing, 'Capital expenditure for Q2 2026 is not captured');
  // Q3 2023 has no long-term debt or securities line, so invested capital a year later cannot be averaged.
  assert.match(metric('roic', rows, { year: 2024, quarter: 3 }).missing!, /Long-term debt at the end of Q3 2023 is not captured/);
  assert.equal(metric('market_cap').value, null);
  assert.match(metric('price_to_sales').missing!, /Market cap for Q2 2026 is not captured/);
  assert.match(metric('revenue_per_employee').missing!, /Total employees/);
  const conflicting = [...rows, obs('revenue', 1 * M, Q2_26)];
  assert.match(metric('operating_margin', conflicting).missing!, /Revenue has conflicting values for Q2 2026/);
});

test('ratios with a zero or negative denominator are not meaningful', () => {
  const loss = rows.map((r) => (r.metric_key === 'net_income' && r.fiscal_year === 2026 && r.fiscal_quarter === 2 ? { ...r, value_numeric: -100 * M } : r));
  assert.equal(metric('payout_ratio', [...loss, obs('us_gaap_PaymentsOfDividends', 1353 * M, Q2_26)]).value, null);
  assert.match(metric('payout_ratio', [...loss, obs('us_gaap_PaymentsOfDividends', 1353 * M, Q2_26)]).missing!, /Not meaningful: net income is zero or negative/);
});

test('price metrics use the period-end market cap and flag an unverified close', () => {
  const market = (verified: boolean) => obs('market_cap', 1_435_262_864_014, Q2_26, { metadata_json: { metric_category: 'market_data', verified }, formula_or_adjustment: 'Market cap = 563.29 close × 2548000000 shares' });
  const withCap = [...rows, market(false)];
  const ps = metric('price_to_sales', withCap);
  near(ps.value, 1_435_262_864_014 / ((51242 + 59893 + 56311 + 60801) * M));
  assert.equal(ps.unverified, true);
  assert.equal(metric('price_to_sales', [...rows, market(true)]).unverified, false);
  near(metric('enterprise_value', withCap).value, 1_435_262_864_014 + (83664 - 15462 - 74798) * M, 1);
  assert.match(metric('market_cap', withCap).note, /563\.29 close/);
  // P/FCF uses trailing FCF, which includes the derived Q3 2025 capex.
  assert.equal(metric('price_to_fcf', withCap).derivedQuarter, true);
});

test('per-employee metrics divide trailing flows by the period-end headcount', () => {
  const people = obs('employees', 75472, Q2_26, { unit: 'persons', currency: null, metadata_json: { metric_category: 'operating_metric', evidence: 'Headcount was 75,472 as of June 30, 2026.' } });
  const list = [...rows, people];
  assert.equal(metric('employees', list).value, 75472);
  near(metric('revenue_per_employee', list).value, (51242 + 59893 + 56311 + 60801) * M / 75472, 1);
  near(metric('ebit_per_employee', list).value, (20535 + 24745 + 22872 + 18775) * M / 75472, 1);
  assert.equal(formatMetric(metric('employees', list).value, 'count'), '75,472');
});

test('annual metrics use fiscal-year flows and year-end balances', () => {
  const annual = [obs('revenue', 200966 * M, { year: 2025, quarter: null }), obs('us_gaap_OperatingIncomeLoss', 83276 * M, { year: 2025, quarter: null }),
    obs('net_income', 60458 * M, { year: 2025, quarter: null }), obs('stockholders_equity', 217243 * M, { year: 2025, quarter: null }), obs('stockholders_equity', 182637 * M, { year: 2024, quarter: null })];
  near(metric('operating_margin', annual, { year: 2025, quarter: null }).value, 83276 / 200966);
  near(metric('roe', annual, { year: 2025, quarter: null }).value, 60458 / ((217243 + 182637) / 2));
  const table = metricCatalogue(annual, 'annual', [{ year: 2025, quarter: null }]);
  assert.equal(table.length, 39);
});

test('year-over-year change is in points for percentages and percent otherwise', () => {
  assert.deepEqual(yearOverYear(0.309, 0.43, 'pct')?.text, '↓ −12.1 pts');
  assert.deepEqual(yearOverYear(12, 10, 'x')?.text, '↑ +20.0%');
  assert.equal(yearOverYear(null, 10, 'x'), null);
});

test('saved chart definitions validate keys, limits and untrusted names', () => {
  const definition = { series: [{ key: 'revenue', as: 'bar', axis: 'left' }, { key: 'metric:operating_margin', as: 'line', axis: 'right' }], chart_type: 'bars', frequency: 'quarterly', range: 'last_8', mode: 'values' };
  assert.equal(savedChartDefinition.safeParse(definition).success, true);
  assert.equal(createSavedChart.parse({ name: '  Revenue\u0000 and\nmargin  ', definition }).name, 'Revenue and margin');
  assert.equal(createSavedChart.safeParse({ name: ' \u0007 ', definition }).success, false);
  assert.equal(createSavedChart.safeParse({ name: 'x'.repeat(121), definition }).success, false);
  assert.equal(savedChartDefinition.safeParse({ ...definition, series: Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, as: 'bar', axis: 'left' })) }).success, false);
  assert.equal(savedChartDefinition.safeParse({ ...definition, series: [definition.series[0], definition.series[0]] }).success, false);
  assert.equal(savedChartDefinition.safeParse({ ...definition, series: [{ key: '<script>', as: 'bar', axis: 'left' }] }).success, false);
  assert.equal(savedChartDefinition.safeParse({ ...definition, values: [1, 2] }).success, false);
  assert.equal(savedChartDefinition.safeParse({ ...definition, chart_type: 'pie' }).success, false);
  assert.equal(updateSavedChart.safeParse({}).success, false);
  assert.equal(updateSavedChart.safeParse({ name: 'Renamed' }).success, true);
});

test('chart series keep gaps, put percentages on the right axis and draw ratios as lines', () => {
  const periods = Q.slice(4);
  const chart = buildChart({ observations: rows, frequency: 'quarterly', specs: [{ key: 'revenue', as: 'bar' }, { key: 'metric:operating_margin', as: 'bar' }, { key: 'us_gaap_ShareBasedCompensation', as: 'bar' }], periods });
  assert.deepEqual(chart.series.map((s) => [s.label, s.axis, s.as]), [['Revenue', 'left', 'bar'], ['Operating margin', 'right', 'line'], ['Share Based Compensation', 'left', 'bar']]);
  assert.equal(chart.left?.kind, 'money');
  assert.equal(chart.right?.kind, 'pct');
  assert.equal(chart.series[2].values[4], null, 'Q3 2025 SBC is a gap in the line-item series, not zero');
  assert.equal(chart.data[4].s2, null);
  assert.equal(chart.data.length, 8);
  const lines = buildChart({ observations: rows, frequency: 'quarterly', specs: [{ key: 'revenue', as: 'bar' }], periods, chartType: 'lines' });
  assert.equal(lines.series[0].as, 'line');
  const stacked = buildChart({ observations: rows, frequency: 'quarterly', specs: [{ key: 'revenue', as: 'bar' }, { key: 'us_gaap_CostOfRevenue', as: 'bar' }], periods, chartType: 'stacked' });
  assert.ok(stacked.series.every((s) => s.stack === 'left'));
  assert.match(chartTakeaway(chart, 'quarterly'), /^Revenue \$60\.8B in Q2 2026, \+28% on a year earlier\.$/);
});

test('YoY mode compares with a year earlier, using values before the window', () => {
  const chart = buildChart({ observations: rows, frequency: 'quarterly', specs: [{ key: 'revenue', as: 'bar' }, { key: 'metric:operating_margin', as: 'line' }], periods: Q.slice(4), mode: 'yoy' });
  near(chart.series[0].values[0], 40589 / 34146 - 1);
  near(chart.series[1].values[7], 18775 / 60801, 1e-6);
  assert.equal(chart.right, null);
  assert.deepEqual(yoySeries([-10, null, 5, 10], 2), [null, null, 1.5, null]);
});

test('series selection: click charts a row alone, additive clicks add up to six series and two units', () => {
  const sel = [{ key: 'a', as: 'bar' as const }];
  assert.deepEqual(toggleSeries(sel, 'b', 'bar', false, true), [{ key: 'b', as: 'bar' }]);
  assert.deepEqual(toggleSeries(sel, 'a', 'bar', false, true), []);
  assert.deepEqual(toggleSeries(sel, 'b', 'line', true, true), [...sel, { key: 'b', as: 'line' }]);
  assert.deepEqual(toggleSeries(sel, 'b', 'line', true, false), sel);
  assert.deepEqual(toggleSeries([...sel, { key: 'b', as: 'bar' }], 'a', 'bar', true, true), [{ key: 'b', as: 'bar' }]);
  const usd = { kind: 'money' as const, currency: 'USD' }, pct = { kind: 'pct' as const, currency: null }, x = { kind: 'x' as const, currency: null };
  assert.equal(canAddSeries([usd, pct], x).reason, 'The chart shows two units at a time');
  assert.equal(canAddSeries([usd, pct], usd).ok, true);
  assert.equal(canAddSeries(Array(6).fill(usd), usd).reason, 'The chart holds 6 series');
});

test('a line item with two values for a period is not charted', () => {
  const series = lineItemSeries([...rows, obs('revenue', 1 * M, Q2_26)], 'quarterly', 'revenue', [Q2_26]);
  assert.equal(series.reason, 'More than one value for Q2 2026');
  assert.equal(lineItemSeries(rows, 'quarterly', 'missing_key', [Q2_26]).reason, 'Not captured for this company');
});

test('axis scales are round, include zero and cover stacked totals', () => {
  assert.deepEqual(niceScale([40589, 60801]), { lo: 0, hi: 80000, ticks: [0, 20000, 40000, 60000, 80000] });
  assert.deepEqual(niceScale([-5, 12]).ticks, [-5, 0, 5, 10, 15]);
  const stacked = buildChart({ observations: rows, frequency: 'quarterly', specs: [{ key: 'revenue', as: 'bar' }, { key: 'us_gaap_CostOfRevenue', as: 'bar' }], periods: [Q2_26], chartType: 'stacked' });
  assert.ok(stacked.left!.scale.hi >= (60801 + 11330) * M);
});
