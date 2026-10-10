/**
 * Chart series for the Financials chart panel and the My charts board.
 *
 * A series key is either a statement line item (an observation `metric_key`, such as `revenue`
 * or `us_gaap_CostOfRevenue`) or a catalogue metric (`metric:operating_margin`). Saved charts
 * store keys, never values, so the same definition refills with any asset's observations.
 */
import { label as plainLabel } from './presentation.mjs';
import { MetricBook, evaluateMetric, formatMetric, metricDef, periodKey, periodName, shiftPeriod, yearLag, type Frequency, type MetricKind, type PeriodRef } from './metric-catalogue';

type Row = Record<string, any>;
export type ChartKind = MetricKind | 'shares';
export type SeriesAs = 'bar' | 'line';
export type ChartType = 'bars' | 'stacked' | 'lines';
export type ChartMode = 'values' | 'yoy';
export type SeriesSpec = { key: string; as: SeriesAs; axis?: 'left' | 'right' };

export const MAX_SERIES = 6;
export const SERIES_COLORS = ['#3d4a5f', '#c0862a', '#3f8f6b', '#b5523f', '#7a64a8', '#2f87a3'];
export const METRIC_PREFIX = 'metric:';

export type ResolvedSeries = {
  key: string;
  label: string;
  kind: ChartKind;
  currency: string | null;
  /** Values for each requested period; null is a gap, never zero. */
  values: (number | null)[];
  /** Why the series cannot be charted, if it cannot. */
  reason: string | null;
};

function rowKind(r: Row): { kind: ChartKind; currency: string | null } | null {
  if (r.unit && r.unit === r.currency && /^[A-Z]{3}$/.test(r.unit)) return { kind: 'money', currency: r.currency };
  if (/^[A-Z]{3}\/shares$/.test(r.unit ?? '')) return { kind: 'ps', currency: r.unit.slice(0, 3) };
  if (r.unit === 'shares') return { kind: 'shares', currency: null };
  if (r.unit === 'persons') return { kind: 'count', currency: null };
  if (r.unit === '%') return { kind: 'pct', currency: null };
  return null;
}

/** A consolidated statement line item over the given periods. */
export function lineItemSeries(observations: Row[], frequency: Frequency, key: string, periods: PeriodRef[]): ResolvedSeries {
  const rows = observations.filter((r) => r.metric_key === key && r.periodicity === frequency && !r.segment && !r.geography && Number.isFinite(r.value_numeric));
  const name = rows.find((r) => r.metadata_json?.statement_label)?.metadata_json.statement_label ?? plainLabel(key.replace(/^us_gaap_/, ''));
  const base = { key, label: name, kind: 'money' as ChartKind, currency: null as string | null, values: periods.map(() => null as number | null) };
  if (!rows.length) return { ...base, reason: 'Not captured for this company' };
  const kinds = new Set(rows.map((r) => JSON.stringify(rowKind(r))));
  const kind = rowKind(rows[0]);
  if (!kind || kinds.size > 1) return { ...base, reason: 'Reported in more than one unit' };
  const values: (number | null)[] = [];
  for (const p of periods) {
    const matches = rows.filter((r) => r.fiscal_year === p.year && (frequency === 'annual' || r.fiscal_quarter === p.quarter));
    const filed = matches.filter((r) => r.metadata_json?.statement);
    const distinct = new Set((filed.length ? filed : matches).map((r) => r.value_numeric));
    if (distinct.size > 1) return { ...base, ...kind, reason: `More than one value for ${periodName(p)}` };
    values.push(distinct.size ? [...distinct][0] : null);
  }
  return { ...base, ...kind, values, reason: null };
}

/** A catalogue metric over the given periods. */
export function metricSeries(book: MetricBook, key: string, periods: PeriodRef[]): ResolvedSeries {
  const def = metricDef(key.slice(METRIC_PREFIX.length));
  if (!def) return { key, label: 'Unknown metric', kind: 'pct', currency: null, values: periods.map(() => null), reason: 'This metric no longer exists' };
  const results = periods.map((p) => evaluateMetric(book, def, p));
  return { key, label: def.name, kind: def.kind, currency: results.find((r) => r.currency)?.currency ?? null, values: results.map((r) => r.value), reason: null };
}

export function resolveSeries(observations: Row[], frequency: Frequency, key: string, periods: PeriodRef[], book = new MetricBook(observations, frequency)) {
  return key.startsWith(METRIC_PREFIX) ? metricSeries(book, key, periods) : lineItemSeries(observations, frequency, key, periods);
}

/** Axis family: two series share an axis only when their values are in the same unit. */
export const unitFamily = (s: Pick<ResolvedSeries, 'kind' | 'currency'>) => (['money', 'ps', 'per_person'].includes(s.kind) ? `${s.kind}:${s.currency ?? ''}` : s.kind);
const familyName: Record<string, string> = { pct: 'percentages', x: 'multiples', count: 'counts', shares: 'share counts' };
export const familyLabel = (family: string) => familyName[family] ?? (family.startsWith('money') ? 'amounts' : family.startsWith('ps') ? 'per-share amounts' : 'amounts per employee');

/** Whether another series can join a chart: six series and two units at most. */
export function canAddSeries(selected: Pick<ResolvedSeries, 'kind' | 'currency'>[], candidate: Pick<ResolvedSeries, 'kind' | 'currency'>): { ok: boolean; reason: string | null } {
  if (selected.length >= MAX_SERIES) return { ok: false, reason: `The chart holds ${MAX_SERIES} series` };
  const families = new Set(selected.map(unitFamily));
  if (!families.has(unitFamily(candidate)) && families.size >= 2) return { ok: false, reason: 'The chart shows two units at a time' };
  return { ok: true, reason: null };
}

/**
 * Row chart button. A plain click charts the row alone (or clears it when it is the only one);
 * an additive click (shift-click on statements, any click on metrics) adds or removes it.
 */
export function toggleSeries(selection: SeriesSpec[], key: string, as: SeriesAs, additive: boolean, canAdd: boolean): SeriesSpec[] {
  const present = selection.some((s) => s.key === key);
  if (additive) return present ? selection.filter((s) => s.key !== key) : canAdd ? [...selection, { key, as }] : selection;
  return present && selection.length === 1 ? [] : [{ key, as }];
}

/** Change against the same period a year earlier; a negative base keeps the direction honest. */
export function yoySeries(values: (number | null)[], lag: number): (number | null)[] {
  return values.map((v, i) => {
    const prior = i - lag >= 0 ? values[i - lag] : null;
    return v === null || prior === null || prior === 0 ? null : (v - prior) / Math.abs(prior);
  });
}

export type ChartSeries = { key: string; label: string; as: SeriesAs; ratio: boolean; axis: 'left' | 'right'; color: string; kind: ChartKind; currency: string | null; stack?: string; values: (number | null)[] };
export type BuiltChart = {
  periods: PeriodRef[];
  data: Record<string, number | string | null>[];
  series: ChartSeries[];
  left: { kind: ChartKind; currency: string | null; scale: Scale } | null;
  right: { kind: ChartKind; currency: string | null; scale: Scale } | null;
  mode: ChartMode;
  omitted: { label: string; reason: string }[];
};

export type Scale = { lo: number; hi: number; ticks: number[] };
/** Round axis bounds and four or five even ticks that always include zero. */
export function niceScale(values: number[]): Scale {
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let x = lo; x <= hi + step / 2; x += step) ticks.push(Number(x.toPrecision(12)));
  return { lo, hi, ticks };
}

export const RANGE_PERIODS = { last_4: 4, last_8: 8, last_12: 12, all: Infinity } as const;
export type ChartRange = keyof typeof RANGE_PERIODS;

/**
 * Build chart rows for the specs over `periods` (oldest first). YoY change needs the prior year,
 * so values are resolved from a year before the first period and trimmed afterwards.
 */
export function buildChart(input: { observations: Row[]; frequency: Frequency; specs: SeriesSpec[]; periods: PeriodRef[]; mode?: ChartMode; chartType?: ChartType; book?: MetricBook }): BuiltChart {
  const { observations, frequency, specs, periods } = input;
  const mode = input.mode ?? 'values', chartType = input.chartType ?? 'bars';
  const book = input.book ?? new MetricBook(observations, frequency);
  const lag = yearLag(frequency);
  const extended = periods.length ? [...Array.from({ length: lag }, (_, i) => shiftPeriod(periods[0], i - lag)), ...periods] : [];
  const omitted: BuiltChart['omitted'] = [];
  const resolved = specs.map((spec) => ({ spec, series: resolveSeries(observations, frequency, spec.key, extended, book) })).filter(({ series }) => {
    if (series.reason) omitted.push({ label: series.label, reason: series.reason });
    return !series.reason;
  });
  const shown = resolved.map(({ spec, series }) => {
    const ratio = series.kind === 'pct';
    const transformed = mode === 'yoy' && !ratio ? yoySeries(series.values, lag) : series.values;
    const kind: ChartKind = mode === 'yoy' ? 'pct' : series.kind;
    return { spec, ratio, series: { ...series, kind, currency: mode === 'yoy' ? null : series.currency, values: transformed.slice(lag) } };
  });
  // Percentages sit on the right axis when anything else is charted; otherwise first unit left.
  const families = [...new Set(shown.map(({ series }) => unitFamily(series)))];
  const rightFamily = families.length > 1 ? (families.includes('pct') ? 'pct' : families[1]) : null;
  const series: ChartSeries[] = shown.map(({ spec, ratio, series: s }, i) => {
    const axis = rightFamily && unitFamily(s) === rightFamily ? 'right' : 'left';
    // Ratios (margins, returns) are always lines, as in the statement prototype.
    const as: SeriesAs = chartType === 'lines' || ratio ? 'line' : spec.as;
    return { key: s.key, label: s.label, as, ratio, axis, color: SERIES_COLORS[i % SERIES_COLORS.length], kind: s.kind, currency: s.currency, values: s.values,
      ...(chartType === 'stacked' && as === 'bar' ? { stack: axis } : {}) };
  });
  const axisOf = (side: 'left' | 'right') => {
    const set = series.filter((x) => x.axis === side);
    if (!set.length) return null;
    // Stacked bars reach the sum of their positive (or negative) parts in a period.
    const extent = periods.flatMap((_, j) => {
      const stacked = set.filter((x) => x.stack).map((x) => x.values[j] ?? 0);
      return [...set.filter((x) => !x.stack).map((x) => x.values[j]).filter((v): v is number => v !== null),
        stacked.filter((v) => v > 0).reduce((a, b) => a + b, 0), stacked.filter((v) => v < 0).reduce((a, b) => a + b, 0)];
    });
    return { kind: set[0].kind, currency: set[0].currency, scale: niceScale(extent) };
  };
  const data = periods.map((p, j) => Object.fromEntries([['period', periodKey(p)], ['label', periodLabel(p)], ...series.map((s, i) => [`s${i}`, s.values[j]])]));
  return { periods, data, series, left: axisOf('left'), right: axisOf('right'), mode, omitted };
}

export const periodLabel = (p: PeriodRef) => (p.quarter ? `Q${p.quarter} ’${String(p.year).slice(2)}` : `FY${p.year}`);

export function formatSeriesValue(value: number | null, kind: ChartKind, currency: string | null) {
  if (value === null) return 'not captured';
  if (kind === 'shares') return `${(value / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}M shares`;
  return formatMetric(value, kind, currency, kind === 'x' ? 2 : undefined);
}
/** Short axis tick labels. */
export function formatAxis(value: number, kind: ChartKind, currency: string | null) {
  if (kind === 'pct') return `${Number((value * 100).toFixed(1))}%`;
  if (kind === 'x') return `${Number(value.toFixed(1))}×`;
  if (kind === 'shares') return `${Math.round(value / 1e6).toLocaleString('en-US')}M`;
  if (kind === 'count') return Math.abs(value) >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
  if (kind === 'ps') return `${currency === 'USD' || !currency ? '$' : currency + ' '}${Number(value.toFixed(2))}`;
  const sign = value < 0 ? '−' : '', a = Math.abs(value), c = currency === 'USD' || !currency ? '$' : `${currency} `;
  if (a >= 1e12) return `${sign}${c}${Number((a / 1e12).toFixed(1))}T`;
  if (a >= 1e9) return `${sign}${c}${Number((a / 1e9).toFixed(1))}B`;
  if (a >= 1e6) return `${sign}${c}${Number((a / 1e6).toFixed(1))}M`;
  if (a >= 1e3) return `${sign}${c}${Number((a / 1e3).toFixed(1))}K`;
  return `${sign}${c}${a}`;
}

export const defaultChartName = (labels: string[]) => (labels.length ? labels.slice(0, 3).join(' vs ') : 'New chart');

/** A one-line summary of the first series: its latest value and change on a year earlier. */
export function chartTakeaway(chart: BuiltChart, frequency: Frequency): string {
  const s = chart.series[0];
  if (!s) return '';
  const last = s.values.findLastIndex((v) => v !== null);
  if (last < 0) return `${s.label}: no values in this range.`;
  const now = s.values[last]!, lag = yearLag(frequency), before = last - lag >= 0 ? s.values[last - lag] : null;
  const head = `${s.label} ${formatSeriesValue(now, s.kind, s.currency)} in ${periodName(chart.periods[last])}`;
  if (before === null || before === 0) return `${head}.`;
  const change = s.kind === 'pct' ? `${now - before >= 0 ? '+' : '−'}${Math.abs((now - before) * 100).toFixed(1)} pts` : `${now - before >= 0 ? '+' : '−'}${Math.abs((now - before) / Math.abs(before) * 100).toFixed(0)}%`;
  return `${head}, ${change} on a year earlier.`;
}

/** Quick-compare presets for a statement, kept to keys the company reports. */
export const CHART_PRESETS: Record<string, { label: string; series: SeriesSpec[] }[]> = {
  income: [
    { label: 'Revenue vs costs', series: [{ key: 'revenue', as: 'bar' }, { key: 'us_gaap_CostsAndExpenses', as: 'bar' }, { key: 'metric:operating_margin', as: 'line' }] },
    { label: 'Profit ladder', series: [{ key: 'revenue', as: 'bar' }, { key: 'metric:gross_profit', as: 'bar' }, { key: 'us_gaap_OperatingIncomeLoss', as: 'bar' }, { key: 'net_income', as: 'bar' }] },
    { label: 'Margins', series: [{ key: 'metric:gross_margin', as: 'line' }, { key: 'metric:operating_margin', as: 'line' }, { key: 'metric:net_margin', as: 'line' }] },
  ],
  balance: [
    { label: 'Assets and equity', series: [{ key: 'total_assets', as: 'bar' }, { key: 'total_liabilities', as: 'bar' }, { key: 'stockholders_equity', as: 'bar' }] },
    { label: 'Cash and debt', series: [{ key: 'us_gaap_CashAndCashEquivalentsAtCarryingValue', as: 'bar' }, { key: 'us_gaap_MarketableSecuritiesCurrent', as: 'bar' }, { key: 'us_gaap_LongTermDebtNoncurrent', as: 'bar' }] },
  ],
  cashflow: [
    { label: 'Cash generation vs capex', series: [{ key: 'operating_cash_flow', as: 'bar' }, { key: 'us_gaap_PaymentsToAcquirePropertyPlantAndEquipment', as: 'bar' }, { key: 'metric:fcf_margin', as: 'line' }] },
    { label: 'Shareholder returns', series: [{ key: 'us_gaap_PaymentsForRepurchaseOfCommonStock', as: 'bar' }, { key: 'us_gaap_PaymentsOfDividends', as: 'bar' }] },
  ],
  metrics: [
    { label: 'Margins', series: [{ key: 'metric:gross_margin', as: 'line' }, { key: 'metric:operating_margin', as: 'line' }, { key: 'metric:fcf_margin', as: 'line' }] },
    { label: 'Returns', series: [{ key: 'metric:roe', as: 'line' }, { key: 'metric:roic', as: 'line' }, { key: 'metric:roa', as: 'line' }] },
    { label: 'Valuation', series: [{ key: 'metric:price_to_earnings', as: 'line' }, { key: 'metric:price_to_fcf', as: 'line' }, { key: 'metric:price_to_sales', as: 'line' }] },
  ],
};
