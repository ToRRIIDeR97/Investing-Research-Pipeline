/**
 * Report exhibits built by code from stored artifacts: the launch catalogue of tables and charts, their placement
 * by chapter coverage, and a chapter's exhibits read back from a stored document.
 *
 * Client-safe: the report view imports this module, so it has no Node or database imports. history/analytics.ts
 * pulls in the market-data service (postgres), so its column-kind map is mirrored here instead of imported.
 */
import type { ReportArtifact, ReportDocument } from './report';
import { buildVisual, type BuiltVisual } from './visuals';
import { withheldValuationReason } from '../valuation/contracts';

/** The report standard whose sections carry code-placed `exhibits`. */
export const EXHIBIT_STANDARD = 'asset-framework-2.1-adaptive-3';

export type ExhibitKey =
  | 'quarterly_results' | 'history_statistics' | 'operating_margin_trend' | 'segment_economics' | 'cash_conversion'
  | 'capital_allocation' | 'scenario_drivers' | 'scenario_values' | 'valuation_bridge' | 'valuation_matrix'
  | 'sensitivity_grid' | 'stress_cases';
export type ExhibitEntry = { key: ExhibitKey; title: string; home: string; fallback: string[] };

/** The launch catalogue, in report order. `home` and `fallback` are chapter coverage keys. */
export const EXHIBITS: readonly ExhibitEntry[] = [
  { key: 'quarterly_results', title: 'Quarterly results', home: 'history', fallback: ['business'] },
  { key: 'history_statistics', title: 'Historical statistics', home: 'history', fallback: ['business'] },
  { key: 'operating_margin_trend', title: 'Operating margin trend', home: 'history', fallback: ['business'] },
  { key: 'segment_economics', title: 'Segment economics', home: 'business', fallback: ['history'] },
  { key: 'cash_conversion', title: 'Cash conversion', home: 'business', fallback: ['history', 'management'] },
  { key: 'capital_allocation', title: 'Capital allocation', home: 'management', fallback: ['business'] },
  { key: 'scenario_drivers', title: 'Scenario drivers', home: 'forecasts', fallback: ['valuation'] },
  { key: 'scenario_values', title: 'Value per share by scenario', home: 'valuation', fallback: [] },
  { key: 'valuation_bridge', title: 'Valuation bridge, base case', home: 'valuation', fallback: [] },
  { key: 'valuation_matrix', title: 'Valuation matrix', home: 'valuation', fallback: [] },
  { key: 'sensitivity_grid', title: 'Sensitivity to discount rate and terminal growth', home: 'valuation', fallback: ['downside'] },
  { key: 'stress_cases', title: 'Stress cases', home: 'downside', fallback: ['valuation'] },
];

export type ExhibitColumn = { key: string; label: string; numeric: boolean };
/** Formatted cells, ready to print. */
export type ExhibitTable = { columns: ExhibitColumn[]; rows: string[][] };
type Base = { key: ExhibitKey; title: string; caption: string; home: string; table: ExhibitTable; notes: string[] };
export type BuiltExhibit = (Base & { kind: 'table' }) | (Base & { kind: 'chart'; chart: BuiltVisual });
export type UnavailableExhibit = { key: ExhibitKey; title: string; home: string; unavailable: string };
export type Exhibit = BuiltExhibit | UnavailableExhibit;

export const isAvailable = (e: Exhibit): e is BuiltExhibit => !('unavailable' in e);

// ---------------------------------------------------------------- formatting

type Kind = 'money' | 'ratio' | 'days' | 'x' | 'shares' | 'per_share' | 'year' | 'text';
// Mirrors columnKind in history/analytics.ts (not importable on the client).
const MONEY = new Set(['revenue', 'operating_income', 'fcf_ttm', 'fcf_after_lease_principal_ttm', 'growth_capex_ttm', 'nopat_ttm', 'net_income_ttm', 'invested_capital',
  'cash', 'marketable_securities', 'long_term_debt', 'net_cash', 'buybacks_ttm', 'dividends_ttm', 'sbc_ttm', 'market_cap',
  'change_in_revenue_ttm', 'change_in_nopat_ttm', 'change_in_invested_capital', 'cumulative_operating_income', 'revenue_ttm', 'operating_income_ttm']);
const TEXT = new Set(['period', 'segment', 'metric', 'latest_period', 'case', 'valuation_set', 'definition', 'role', 'class', 'from', 'to']);
function kindOf(column: string): Kind {
  if (TEXT.has(column)) return 'text';
  if (column === 'fiscal_year' || column === 'years' || column === 'n') return 'year';
  if (column === 'value_per_share') return 'per_share';
  if (/^(dso|dpo|dio|ccc)$/.test(column)) return 'days';
  if (column === 'capex_to_da' || column === 'revenue_to_net_ppe') return 'x';
  if (column === 'shares' || column === 'shares_year_ago') return 'shares';
  return MONEY.has(column) ? 'money' : 'ratio';
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Fixed decimals with thousands separators; a value that rounds to zero loses its sign. */
function fixed(value: number, decimals: number, trimZeros = false): string {
  let text = Math.abs(value).toFixed(decimals);
  if (trimZeros && text.includes('.')) text = text.replace(/\.?0+$/, '');
  const [whole, fraction] = text.split('.');
  const zero = /^[0.]*$/.test(text);
  return `${value < 0 && !zero ? '-' : ''}${group(whole)}${fraction ? `.${fraction}` : ''}`;
}
const MISSING = '—';
function formatCell(value: unknown, kind: Kind): string {
  if (value === null || value === undefined || value === '') return MISSING;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return kind === 'text' ? readerWords(value) : value;
  if (!finite(value)) return MISSING;
  switch (kind) {
    case 'ratio': return `${fixed(value * 100, 1)}%`;
    case 'money': case 'shares': return fixed(value, 1, true);
    case 'per_share': return fixed(value, 2);
    case 'days': return fixed(value, 0);
    case 'x': return `${fixed(value, 1)}x`;
    case 'year': return String(Math.round(value));
    default: return String(value);
  }
}
/** Stored short words ("base", "conservative") read capitalised; other text is kept. */
const readerWords = (text: string) => /^[a-z][a-z0-9_]*$/.test(text) ? label(text) : text;

const ACRONYMS: Record<string, string> = {
  ttm: 'TTM', yoy: 'YoY', fcf: 'FCF', ocf: 'OCF', roic: 'ROIC', roe: 'ROE', nopat: 'NOPAT', sbc: 'SBC', ev: 'EV', ebit: 'EBIT',
  ebitda: 'EBITDA', eps: 'EPS', gaap: 'GAAP', usd: 'USD', dso: 'DSO', dpo: 'DPO', dio: 'DIO', ccc: 'CCC', nwc: 'NWC', capm: 'CAPM',
  wacc: 'WACC', da: 'D&A', ronic: 'RONIC', ppe: 'PP&E',
};
const LABELS: Record<string, string> = {
  period: 'Quarter', fiscal_year: 'Year', loss_to_earner_operating_income: 'Loss vs profitable segments’ operating income',
  return_to_value: 'Return to value', return: 'Return', value_per_share: 'Value per share',
};
/** Reader words for a stored key: no underscores, acronyms upper case. */
export function label(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const words = key.split(/[_\s]+/).filter(Boolean).map(w => ACRONYMS[w.toLowerCase()] ?? w);
  if (!words.length) return key;
  if (!ACRONYMS[words[0].toLowerCase()] && words[0] !== words[0].toUpperCase()) words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

// ---------------------------------------------------------------- stored tables

type Columnar = { columns: string[]; rows: unknown[][] };
function columnar(value: unknown, name: string): Columnar {
  const t = value as Partial<Columnar> | null | undefined;
  if (!t || !Array.isArray(t.columns) || !t.columns.every(c => typeof c === 'string') || !Array.isArray(t.rows) || !t.rows.every(Array.isArray))
    throw new Unavailable(`The stored ${name} table is malformed.`);
  return t as Columnar;
}
class Unavailable extends Error {}

/** Selected columns of a columnar table, formatted by kind; columns absent from the source are left out. */
function tableOf(source: Columnar, wanted: string[] | null, options: { last?: number; kinds?: (column: string, row: unknown[]) => Kind } = {}): ExhibitTable {
  const keys = (wanted ?? source.columns).filter(c => source.columns.includes(c));
  const at = keys.map(c => source.columns.indexOf(c));
  const rows = options.last ? source.rows.slice(-options.last) : source.rows;
  return {
    columns: keys.map(key => ({ key, label: label(key), numeric: kindOf(key) !== 'text' })),
    rows: rows.map(row => keys.map((key, i) => formatCell(row[at[i]], options.kinds ? options.kinds(key, row) : kindOf(key)))),
  };
}

const millionsCaption = (currency: unknown) => `${typeof currency === 'string' && currency.trim() ? currency.trim() : 'Reported currency'} millions`;
const priceCurrency = (c: Record<string, any>) => {
  const fromInputs = Array.isArray(c.method_inputs) ? c.method_inputs.find((m: any) => typeof m?.currency === 'string')?.currency : undefined;
  const currency = typeof c.currency === 'string' && c.currency.trim() ? c.currency.trim() : fromInputs;
  return typeof currency === 'string' && currency ? currency : 'the reported currency';
};

/** The newest artifact of a type: highest artifact_version, the first listed on a tie. */
function newest(artifacts: ReportArtifact[], type: string): ReportArtifact | undefined {
  let best: ReportArtifact | undefined;
  for (const a of artifacts) if (a?.artifact_type === type && (!best || Number(a.artifact_version) > Number(best.artifact_version))) best = a;
  return best;
}
const contentOf = (artifact: ReportArtifact | undefined, type: string, name: string): Record<string, any> => {
  if (!artifact) throw new Unavailable(`No stored ${name}.`);
  const c = artifact.content_json;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Unavailable(`The stored ${name} is malformed.`);
  return c;
};

// ---------------------------------------------------------------- builders

type Context = { artifacts: ReportArtifact[]; cutoff?: string; analytics?: ReportArtifact; operating?: ReportArtifact; valuation?: ReportArtifact };
type Own = 'key' | 'title' | 'home';
type Built = Omit<Extract<BuiltExhibit, { kind: 'table' }>, Own> | Omit<Extract<BuiltExhibit, { kind: 'chart' }>, Own>;
const LAST_QUARTERS = 8;

const analytics = (ctx: Context) => contentOf(ctx.analytics, 'financial_analytics', 'financial analytics');
function nonEmpty(table: ExhibitTable, name: string): ExhibitTable {
  if (!table.rows.length || table.columns.length < 2) throw new Unavailable(`The stored ${name} table has no rows.`);
  return table;
}

function quarterlyResults(ctx: Context): Built {
  const c = analytics(ctx);
  const table = nonEmpty(tableOf(columnar(c.quarterly, 'quarterly'),
    ['period', 'revenue', 'revenue_yoy', 'operating_income', 'gross_margin', 'operating_margin', 'fcf_margin'], { last: LAST_QUARTERS }), 'quarterly');
  return { kind: 'table', table, caption: `Last ${table.rows.length} quarters. Revenue and operating income in ${millionsCaption(c.currency)}; growth and margins in percent.`, notes: [] };
}

function historyStatistics(ctx: Context): Built {
  const c = analytics(ctx);
  const source = columnar(c.statistics, 'statistics');
  const metric = source.columns.indexOf('metric');
  if (metric < 0) throw new Unavailable('The stored statistics table has no metric column.');
  const table = nonEmpty(tableOf(source, ['metric', 'median', 'min', 'max', 'latest', 'percentile'], {
    kinds: (column, row) => column === 'metric' ? 'text' : column === 'percentile' ? 'ratio' : kindOf(String(row[metric])),
  }), 'statistics');
  const window = c.window && typeof c.window === 'object' ? c.window : {};
  const span = typeof window.start === 'string' && typeof window.end === 'string' ? ` from ${window.start} to ${window.end}` : '';
  return { kind: 'table', table, caption: `Each measure over the stored history${span}. Amounts in ${millionsCaption(c.currency)}, ratios in percent, days as days.`,
    notes: ['Percentile places the latest value within the measure’s own history.'] };
}

function operatingMarginTrend(ctx: Context): Built {
  const c = analytics(ctx);
  const source = columnar(c.quarterly, 'quarterly');
  const period = source.columns.indexOf('period'), operating = source.columns.indexOf('operating_margin'), gross = source.columns.indexOf('gross_margin');
  if (period < 0 || operating < 0) throw new Unavailable('The stored quarterly table has no operating margin.');
  const count = (i: number) => i < 0 ? 0 : source.rows.filter(r => finite(r[i])).length;
  if (count(operating) < 2) throw new Unavailable('The operating margin needs at least two stored quarters.');
  const series = [{ key: 'operating_margin', i: operating }, ...(count(gross) >= 2 ? [{ key: 'gross_margin', i: gross }] : [])];
  const labels = series.map(s => label(s.key));
  const points = source.rows.map(r => ({ key: String(r[period]), period: String(r[period]),
    values: series.map(s => finite(r[s.i]) ? Number(((r[s.i] as number) * 100).toFixed(4)) : null),
    exact: series.map(s => formatCell(r[s.i], 'ratio')) }));
  const chart: BuiltVisual = { display: 'lines', category: 'Quarter', labels, columns: labels, unit: '%', points, notes: [] };
  const table: ExhibitTable = { columns: [{ key: 'period', label: 'Quarter', numeric: false }, ...series.map(s => ({ key: s.key, label: label(s.key), numeric: true }))],
    rows: points.map(p => [p.period, ...p.exact]) };
  return { kind: 'chart', chart, table, caption: `Quarterly margins in percent, ${points[0].period} to ${points.at(-1)!.period}.`, notes: [] };
}

function segmentEconomics(ctx: Context): Built {
  const c = analytics(ctx);
  const segments = c.segments && typeof c.segments === 'object' ? c.segments : {};
  const table = nonEmpty(tableOf(columnar(segments.annual, 'segment'),
    ['fiscal_year', 'segment', 'revenue', 'operating_income', 'operating_margin', 'loss_to_earner_operating_income']), 'segment');
  return { kind: 'table', table, caption: `Annual results by reported segment. Amounts in ${millionsCaption(c.currency)}; margins in percent.`, notes: [] };
}

function cashConversion(ctx: Context): Built {
  const c = analytics(ctx);
  const cash = c.cash_conversion && typeof c.cash_conversion === 'object' ? c.cash_conversion : {};
  const table = nonEmpty(tableOf(columnar(cash.quarterly, 'cash conversion'),
    ['period', 'fcf_ttm', 'fcf_to_net_income', 'ocf_to_net_income', 'capex_to_da', 'nopat_ttm', 'invested_capital', 'roic'], { last: LAST_QUARTERS }), 'cash conversion');
  return { kind: 'table', table, caption: `Last ${table.rows.length} quarters, trailing twelve months. Amounts in ${millionsCaption(c.currency)}; ratios in percent, capex to D&A as a multiple.`, notes: [] };
}

function capitalAllocation(ctx: Context): Built {
  const c = analytics(ctx);
  const capital = c.capital_allocation && typeof c.capital_allocation === 'object' ? c.capital_allocation : {};
  const table = nonEmpty(tableOf(columnar(capital.quarterly, 'capital allocation'),
    ['period', 'net_cash', 'shares', 'shares_yoy', 'buybacks_ttm', 'dividends_ttm', 'sbc_ttm', 'buybacks_to_fcf', 'fcf_yield'], { last: LAST_QUARTERS }), 'capital allocation');
  return { kind: 'table', table, caption: `Last ${table.rows.length} quarters. Amounts in ${millionsCaption(c.currency)}, shares in millions; ratios and yields in percent.`, notes: [] };
}

const SCENARIOS = ['bear', 'base', 'bull'] as const;
const SCENARIO_LABELS = ['Bear', 'Base', 'Bull'];
function scenarioDrivers(ctx: Context): Built {
  const c = contentOf(ctx.operating, 'operating_scenario_set', 'operating scenarios');
  const scenarios: any[] = Array.isArray(c.scenarios) ? c.scenarios : [];
  const byCase = SCENARIOS.map(t => {
    const drivers = scenarios.find(s => s?.scenario_type === t)?.yearly_drivers;
    return new Map<number, any>((Array.isArray(drivers) ? drivers : []).filter(d => Number.isInteger(d?.fiscal_year)).map(d => [d.fiscal_year, d]));
  });
  const years = [...new Set(byCase.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  if (!years.length) throw new Unavailable('The stored operating scenarios have no yearly drivers.');
  const metrics = ['revenue_growth', 'operating_margin'];
  const columns: ExhibitColumn[] = [{ key: 'fiscal_year', label: 'Year', numeric: false },
    ...metrics.flatMap(m => SCENARIOS.map((t, i) => ({ key: `${t}_${m}`, label: `${SCENARIO_LABELS[i]} ${label(m).toLowerCase()}`, numeric: true })))];
  const rows = years.map(y => [`FY${y}`, ...metrics.flatMap(m => byCase.map(map => formatCell(map.get(y)?.[m], 'ratio')))]);
  return { kind: 'table', table: { columns, rows }, caption: 'Forecast revenue growth and operating margin by year for each operating case, in percent.', notes: [] };
}

function valuationSet(ctx: Context): Record<string, any> {
  const c = contentOf(ctx.valuation, 'valuation_scenario_set', 'valuation');
  const withheld = withheldValuationReason(c);
  if (withheld) throw new Unavailable(withheld);
  return c;
}
/** A chart built by visuals.ts; its errors become the unavailable reason. */
function visual(spec: Parameters<typeof buildVisual>[0], ctx: Context): BuiltVisual {
  try { return buildVisual(spec, ctx.artifacts, ctx.cutoff); }
  catch (error) { throw new Unavailable(error instanceof Error ? error.message : 'The chart could not be built.'); }
}

function scenarioValues(ctx: Context): Built {
  const c = valuationSet(ctx);
  const chart = visual({ kind: 'scenarios', title: 'Value per share by scenario', caption: '', artifact_id: ctx.valuation!.id, metric: 'value_per_share', unit: '' }, ctx);
  if (chart.points.length < 2) throw new Unavailable('The scenario chart needs at least two scenarios.');
  const table: ExhibitTable = { columns: [{ key: 'scenario', label: 'Scenario', numeric: false }, { key: 'value_per_share', label: 'Value per share today', numeric: true }],
    rows: chart.points.map(p => [p.period, formatCell(p.values[0], 'per_share')]) };
  return { kind: 'chart', chart, table, caption: `Value per share today in ${chart.unit.replace(/ per share$/, '') || priceCurrency(c)}, recalculated from the stored valuation inputs.`, notes: chart.notes };
}

function valuationBridge(ctx: Context): Built {
  valuationSet(ctx);
  const chart = visual({ kind: 'valuation_bridge', title: 'Valuation bridge', caption: '', artifact_id: ctx.valuation!.id, scenario: 'base' }, ctx);
  if (chart.points.length < 2) throw new Unavailable('The valuation bridge needs at least two steps.');
  const table: ExhibitTable = { columns: [{ key: 'step', label: 'Step', numeric: false }, { key: 'value', label: 'Value', numeric: true }],
    rows: chart.points.map(p => [p.period, formatCell(p.values[0], 'money')]) };
  return { kind: 'chart', chart, table, caption: `From discounted cash flows to equity value, base case, in ${chart.unit}.`, notes: chart.notes };
}

function valuationMatrix(ctx: Context): Built {
  const c = valuationSet(ctx);
  const table = nonEmpty(tableOf(columnar(c.valuation_matrix, 'valuation matrix'),
    ['case', 'valuation_set', 'discount_rate', 'terminal_growth', 'ronic', 'value_per_share', 'return_to_value']), 'valuation matrix');
  return { kind: 'table', table, caption: `Value per share today in ${priceCurrency(c)} for each operating case under each valuation set; rates and returns in percent.`,
    notes: ['Return to value compares each value with the stored market price.'] };
}

function sensitivityGrid(ctx: Context): Built {
  const c = valuationSet(ctx);
  const source = columnar(c.sensitivity_grid, 'sensitivity grid');
  const [r, g, v] = ['discount_rate', 'terminal_growth', 'value_per_share'].map(k => source.columns.indexOf(k));
  if (r < 0 || g < 0 || v < 0) throw new Unavailable('The stored sensitivity grid lacks its rate, growth or value column.');
  const cells = source.rows.filter(row => finite(row[r]) && finite(row[g]));
  const rates = [...new Set(cells.map(row => row[r] as number))].sort((a, b) => a - b);
  const growths = [...new Set(cells.map(row => row[g] as number))].sort((a, b) => a - b);
  if (rates.length < 2 || growths.length < 2) throw new Unavailable('The sensitivity grid needs at least two discount rates and two growth rates.');
  const value = (rate: number, growth: number) => cells.find(row => row[r] === rate && row[g] === growth)?.[v];
  const table: ExhibitTable = {
    columns: [{ key: 'discount_rate', label: 'Discount rate', numeric: true },
      ...growths.map(growth => ({ key: `terminal_growth_${growth}`, label: `Terminal growth ${formatCell(growth, 'ratio')}`, numeric: true }))],
    rows: rates.map(rate => [formatCell(rate, 'ratio'), ...growths.map(growth => formatCell(value(rate, growth), 'per_share'))]),
  };
  const scenario = typeof (source as any).case === 'string' ? `${label((source as any).case).toLowerCase()} case` : 'base case';
  return { kind: 'table', table, caption: `Value per share today in ${priceCurrency(c)}, ${scenario}, by discount rate (rows) and terminal growth (columns).`,
    notes: ['A dash marks a combination where terminal growth is not below the discount rate, which has no value.'] };
}

function stressCases(ctx: Context): Built {
  const c = valuationSet(ctx);
  const cases: any[] = Array.isArray(c.stress_cases) ? c.stress_cases.filter((s: unknown) => s && typeof s === 'object') : [];
  if (!cases.length) throw new Unavailable('No stored stress cases.');
  const keys = ['case', 'value_per_share', 'return', 'definition'];
  const table: ExhibitTable = { columns: keys.map(key => ({ key, label: label(key), numeric: kindOf(key) !== 'text' })),
    rows: cases.map(s => keys.map(key => formatCell(s[key], kindOf(key)))) };
  return { kind: 'table', table, caption: `Value per share today in ${priceCurrency(c)} under severe assumptions; return against the stored market price, in percent.`, notes: [] };
}

const BUILDERS: Record<ExhibitKey, (ctx: Context) => Built> = {
  quarterly_results: quarterlyResults, history_statistics: historyStatistics, operating_margin_trend: operatingMarginTrend,
  segment_economics: segmentEconomics, cash_conversion: cashConversion, capital_allocation: capitalAllocation,
  scenario_drivers: scenarioDrivers, scenario_values: scenarioValues, valuation_bridge: valuationBridge,
  valuation_matrix: valuationMatrix, sensitivity_grid: sensitivityGrid, stress_cases: stressCases,
};

/** Every launch exhibit, in catalogue order, built from the newest stored artifact of each type. Never throws. */
export function buildExhibits(artifacts: ReportArtifact[], options: { cutoff?: string } = {}): Exhibit[] {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const ctx: Context = { artifacts: list, cutoff: options.cutoff, analytics: newest(list, 'financial_analytics'),
    operating: newest(list, 'operating_scenario_set'), valuation: newest(list, 'valuation_scenario_set') };
  return EXHIBITS.map(({ key, title, home }) => {
    try {
      return { key, title, home, ...BUILDERS[key](ctx) } as BuiltExhibit;
    } catch (error) {
      const unavailable = error instanceof Unavailable ? error.message : 'The stored data could not be read for this exhibit.';
      return { key, title, home, unavailable };
    }
  });
}

/**
 * Exhibit keys per section: each available exhibit goes to the first non-conclusion section covering its home area,
 * else the first covering a fallback (in order), else nowhere; each at most once.
 */
export function placeExhibits(sections: { id: string; coverage: string[] }[], exhibits: Exhibit[]): Record<string, string[]> {
  const placed: Record<string, string[]> = Object.fromEntries(sections.map(s => [s.id, [] as string[]]));
  const body = sections.filter(s => !(Array.isArray(s.coverage) && s.coverage.includes('conclusion')));
  const entries = new Map(EXHIBITS.map(e => [e.key as string, e]));
  const seen = new Set<string>();
  for (const exhibit of exhibits) {
    if (!isAvailable(exhibit) || seen.has(exhibit.key)) continue;
    const entry = entries.get(exhibit.key);
    const areas = [exhibit.home, ...(entry?.fallback ?? [])];
    for (const area of areas) {
      const section = body.find(s => Array.isArray(s.coverage) && s.coverage.includes(area));
      if (section) { placed[section.id].push(exhibit.key); seen.add(exhibit.key); break; }
    }
  }
  return placed;
}

/** The built exhibits a stored chapter names, in its order; [] for an unknown section or a document of an earlier standard. */
export function chapterExhibits(document: ReportDocument, sectionId: string): BuiltExhibit[] {
  if (document?.standard_version !== EXHIBIT_STANDARD) return [];
  const section = (document.sections ?? []).find(s => s.id === sectionId);
  const keys = (section as { exhibits?: unknown } | undefined)?.exhibits;
  if (!Array.isArray(keys) || !keys.length) return [];
  const built = new Map(buildExhibits(document.artifacts ?? [], { cutoff: document.cutoff }).filter(isAvailable).map(e => [e.key as string, e]));
  const seen = new Set<string>();
  return keys.flatMap(key => {
    if (typeof key !== 'string' || seen.has(key)) return [];
    seen.add(key);
    const exhibit = built.get(key);
    return exhibit ? [exhibit] : [];
  });
}
