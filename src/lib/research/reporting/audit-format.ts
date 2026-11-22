import { money, plainLabel } from './plain-english';

/**
 * Reader text for the Audit and Financials views: metric values in their stored unit, provider and source-type
 * names, and backtest results. Readers never see snake_case keys, raw floats or JSON.
 */

type Row = Record<string, any>;
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const trim = (n: number, places: number) => Number(n.toFixed(places)).toLocaleString('en-US', { maximumFractionDigits: places });
const signedPct = (r: number, places = 1) => `${r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(places)}%`;

/** Words for a key: "basis_points_change" → "Basis points change". */
export function words(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const spaced = text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const providers: Record<string, string> = {
  sec_companyfacts: 'SEC company facts', 'metric-reconciler': 'Computed from filings', yahoo: 'Yahoo Finance', fred: 'FRED',
};
export const providerLabel = (value: unknown) => providers[String(value ?? '').toLowerCase()] ?? words(value);

const sourceTypes: Record<string, string> = {
  sec_filing_def_14a: 'SEC proxy statement (DEF 14A)', sec_filing_schedule_13g: 'SEC ownership filing (13G)', sec_filing_10_k: 'SEC annual report (10-K)',
  sec_filing_10_q: 'SEC quarterly report (10-Q)', sec_filing_8_k: 'SEC current report (8-K)', market_data_snapshot: 'Market data snapshot',
  web_macro_dataset: 'Macro dataset (web)', peer_industry_context: 'Peer and industry context', macro_context: 'Macro context',
  web_founder_and_company_history: 'Founder and company history (web)', web_peer_company_primary: 'Peer company filing (web)',
};
export function sourceTypeLabel(value: unknown): string {
  const key = String(value ?? '').toLowerCase();
  if (sourceTypes[key]) return sourceTypes[key];
  const sec = /^sec_filing_(.+)$/.exec(key);
  if (sec) return `SEC filing (${sec[1].replace(/_/g, '-').toUpperCase()})`;
  const text = words(value);
  const web = /^web (.+)$/i.exec(text);
  return web ? `${web[1].charAt(0).toUpperCase()}${web[1].slice(1)} (web)` : text;
}

/** A metric value in its stored unit: USD amounts as money, percentages, basis points, scaled currency units. */
export function metricValue(value: unknown, unit: unknown, currency?: unknown): string {
  const v = num(value);
  if (v == null) return typeof value === 'string' && value.trim() ? value : '—';
  const u = String(unit ?? '').toLowerCase();
  const code = (/^([a-z]{3})(?:_|$)/.exec(u)?.[1] ?? String(currency ?? '').toLowerCase()) || '';
  if (/percent/.test(u)) return `${trim(v, 2)}%${/annuali[sz]ed/.test(u) ? ' a year' : ''}`;
  if (/basis_points_change/.test(u)) return `${v > 0 ? '+' : v < 0 ? '−' : ''}${trim(Math.abs(v), 1)} bp`;
  if (/basis_points/.test(u)) return `${trim(v, 1)} bp`;
  if (/^[a-z]{3}(_(thousands?|millions?|billions?))?$/.test(u) && code) {
    const scale = /thousand/.test(u) ? 1e3 : /million/.test(u) ? 1e6 : /billion/.test(u) ? 1e9 : 1;
    return money(v * scale, code.toUpperCase());
  }
  if (/shares?/.test(u)) { const a = Math.abs(v); return a >= 1e9 ? `${(v / 1e9).toFixed(2)}bn shares` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}m shares` : `${trim(v, 0)} shares`; }
  if (/ratio|multiple|^x$/.test(u)) return `${trim(v, 2)}x`;
  return `${trim(v, Math.abs(v) < 10 ? 2 : 1)}${u ? ` ${words(u).toLowerCase()}` : ''}`;
}

/** A metric's reader name: the definition's display name, else its key in plain words. */
export function metricName(row: Row): string {
  const display = typeof row.metric_display_name === 'string' ? row.metric_display_name.trim() : '';
  // Some definitions store their key as the display name ("total_loans_gross"); those read as words too.
  if (display && !/^[a-z0-9_]+$/.test(display)) return display;
  const key = display || row.metric_key;
  return key ? plainLabel(key) : 'Unnamed metric';
}

export interface BacktestLine { label: string; full: string; inSample: string | null; outOfSample: string | null }
const backtestMeasures: [string, string, (v: number) => string][] = [
  ['total_return', 'Total return', (v) => signedPct(v, 0)],
  ['cagr', 'Return a year', (v) => signedPct(v)],
  ['sharpe', 'Sharpe ratio', (v) => `${v < 0 ? '−' : ''}${trim(Math.abs(v), 2)}`],
  ['max_drawdown', 'Largest fall', (v) => signedPct(v, 0)],
  ['win_rate', 'Winning trades', (v) => signedPct(v, 0)],
  ['volatility', 'Volatility', (v) => signedPct(v, 0)],
  ['number_of_trades', 'Trades', (v) => trim(v, 0)],
];
/** A backtest's results with the in-sample and out-of-sample split side by side, when stored. */
export function backtestLines(metrics: unknown): { lines: BacktestLine[]; splitDate: string | null; verdict: string | null } {
  const m = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics as Row : {};
  const ins = m.in_sample && typeof m.in_sample === 'object' ? m.in_sample as Row : null;
  const out = m.out_of_sample && typeof m.out_of_sample === 'object' ? m.out_of_sample as Row : null;
  const lines = backtestMeasures.flatMap(([key, label, fmt]) => {
    const all = num(m[key] ?? (key === 'sharpe' ? m.sharpe_ratio : undefined));
    const a = num(ins?.[key]), b = num(out?.[key]);
    if (all == null && a == null && b == null) return [];
    return [{ label, full: all == null ? '—' : fmt(all), inSample: a == null ? null : fmt(a), outOfSample: b == null ? null : fmt(b) }];
  });
  return { lines, splitDate: typeof m.split_date === 'string' ? m.split_date : null, verdict: typeof m.status === 'string' ? m.status : null };
}
