"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { SUM_PREFIX, buildChart, canAddSeries, defaultChartName, formatSeriesValue, parseSumKey, resolveSeries, sumKey, unitFamily,
  type ChartMode, type ChartRange, type ResolvedSeries, type SeriesSpec, type SumTerm } from '@/lib/research/reporting/chart-series';
import { periodName, type Frequency, type MetricBook, type PeriodRef } from '@/lib/research/reporting/metric-catalogue';
import type { SavedChart } from '@/lib/research/reporting/saved-charts';
import { SeriesChart } from './series-chart';
import { SeriesSearch } from './series-search';
import type { SeriesOptionGroup } from './charts-board';
import type { SavedChartsApi } from './use-saved-charts';
import styles from './financials.module.css';
import { SlideGroup } from '@/components/ui/sliding';

type Row = Record<string, any>;
export type Preset = { label: string; series: SeriesSpec[] };
type ShowAs = 'separate' | 'stacked' | 'total';

export const rangeFor = (count: number): ChartRange => (count <= 4 ? 'last_4' : count <= 8 ? 'last_8' : count <= 12 ? 'last_12' : 'all');
const summable = (s: ResolvedSeries) => !s.reason && s.kind !== 'pct' && s.kind !== 'x';

/**
 * The chart over a statement or the metrics: a command bar to add line items and saved bundles,
 * series chips, and "show as" separate, stacked or one total. A bundle is a saved chart: its line
 * items, not this company's numbers, so it refills for any company.
 */
export function ChartPanel({ observations, frequency, book, periods, selection, onSelection, presets, options = [], lines = false, saved, boardHref, label, empty }: {
  observations: Row[]; frequency: Frequency; book: MetricBook; periods: PeriodRef[];
  selection: SeriesSpec[]; onSelection: (next: SeriesSpec[]) => void; presets: Preset[];
  /** Everything the command bar can add. */
  options?: SeriesOptionGroup[];
  /** Metrics chart every series as a line; statements let each series be a bar or a line. */
  lines?: boolean; saved: SavedChartsApi; boardHref: string; label: string; empty: string;
}) {
  const [title, setTitle] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>('values');
  const [stacked, setStacked] = useState(false);
  const [combine, setCombine] = useState<{ terms: SumTerm[]; name: string } | null>(null);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const chartType = lines ? 'lines' as const : stacked ? 'stacked' as const : 'bars' as const;
  const chart = useMemo(() => buildChart({ observations, frequency, specs: selection, periods, mode, chartType, book }), [observations, frequency, selection, periods, mode, chartType, book]);
  const resolve = useCallback((key: string, label?: string) => resolveSeries(observations, frequency, key, periods, book, label), [observations, frequency, periods, book]);
  const resolved = useMemo(() => selection.map((s) => resolve(s.key, s.label)), [selection, resolve]);
  const check = useCallback((s: ResolvedSeries) => canAddSeries(resolved.filter((r) => !r.reason), s).reason, [resolved]);
  const name = title ?? defaultChartName(chart.series.map((s) => s.label));
  const hasSum = selection.some((s) => s.key.startsWith(SUM_PREFIX));
  const showAs: ShowAs = hasSum ? 'total' : stacked ? 'stacked' : 'separate';
  // Money series of one unit that can be added together, in chart order.
  const addable = selection.filter((s, i) => !s.key.startsWith(SUM_PREFIX) && summable(resolved[i]));
  const sameUnit = addable.length >= 2 && new Set(addable.map((s) => unitFamily(resolved[selection.indexOf(s)]))).size === 1;

  const change = (next: SeriesSpec[]) => { setStatus(null); setCombine(null); onSelection(next); };
  const lag = frequency === 'annual' ? 1 : 4;
  const lastPeriod = periods.at(-1);
  function sumInto(terms: SumTerm[], label: string) {
    const keys = new Set(terms.map((t) => t.key));
    const first = selection.findIndex((s) => keys.has(s.key));
    const spec: SeriesSpec = { key: sumKey(terms), as: 'bar', label: label.trim() || undefined };
    const rest = selection.filter((s) => !keys.has(s.key));
    change([...rest.slice(0, first), spec, ...rest.slice(first)]);
  }
  function split(spec: SeriesSpec) {
    const terms = parseSumKey(spec.key) ?? [];
    const at = selection.indexOf(spec);
    change([...selection.slice(0, at), ...terms.map((t) => ({ key: t.key, as: 'bar' as const })), ...selection.slice(at + 1)].slice(0, 6));
  }
  function showAsChange(next: ShowAs) {
    setStatus(null);
    if (next === 'total') { if (sameUnit) { sumInto(addable.map((s) => ({ key: s.key, sign: 1 })), title ?? 'Total'); setStacked(false); } return; }
    setStacked(next === 'stacked');
    if (hasSum) {
      const expanded = selection.flatMap((s) => s.key.startsWith(SUM_PREFIX) ? (parseSumKey(s.key) ?? []).map((t) => ({ key: t.key, as: 'bar' as const })) : [s]);
      change(expanded.slice(0, 6));
    }
  }
  function loadBundle(c: SavedChart) {
    setStacked(c.definition.chart_type === 'stacked');
    setMode(c.definition.mode);
    change(c.definition.series.map(({ key, as, label }) => ({ key, as, ...(label ? { label } : {}) })));
    setTitle(c.name);
  }

  const definition = {
    series: chart.series.map((s) => { const spec = selection.find((x) => x.key === s.key); return { key: s.key, as: spec?.as ?? s.as, axis: s.axis, ...(spec?.label ? { label: spec.label } : {}) }; }),
    chart_type: chartType, frequency, range: rangeFor(periods.length), mode,
  };
  // The same name and definition are saved once; any change allows another save.
  const signature = JSON.stringify([name.trim(), definition]);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const isSaved = lastSaved === signature;

  async function save() {
    if (!chart.series.length || saving || isSaved) return;
    setSaving(true);
    try {
      await saved.create(name, definition);
      setLastSaved(signature);
      setStatus({ kind: 'saved', text: `Saved bundle “${name}”. It fills in for any company.` });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus(null), 5000);
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return <section className={styles.panel} aria-label={label}>
    <div className={styles.panelHead}>
      <label className={styles.srOnly} htmlFor="chart-name">Chart name</label>
      <input id="chart-name" className={styles.titleInput} value={name} maxLength={120} onChange={(e) => { setTitle(e.target.value); setStatus(null); }} />
      <div className={styles.panelTools}>
        {!lines && <SlideGroup className={styles.segmentedSmall} label="Show series as">
          {([['separate', 'Separate'], ['stacked', 'Stacked'], ['total', 'One total']] as const).map(([value, text]) => <button key={value} type="button" aria-pressed={showAs === value}
            disabled={value === 'total' && !hasSum && !sameUnit} title={value === 'total' && !hasSum && !sameUnit ? 'Add two or more amounts in the same unit to total them' : undefined}
            onClick={() => showAsChange(value)}>{text}</button>)}
        </SlideGroup>}
        <SlideGroup className={styles.segmentedSmall} label="Chart values">
          {([['values', 'Values'], ['yoy', 'YoY %']] as const).map(([value, text]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => { setMode(value); setStatus(null); }}>{text}</button>)}
        </SlideGroup>
        <button type="button" className={styles.ghostButton} onClick={() => { change([]); setTitle(null); setStacked(false); }} disabled={!selection.length}>Clear</button>
        <button type="button" className={styles.primaryButton} onClick={() => void save()} disabled={!chart.series.length || saving || isSaved}>{saving ? 'Saving…' : isSaved ? 'Saved' : 'Save as bundle'}</button>
      </div>
    </div>
    {!!options.length && <SeriesSearch options={options} bundles={saved.charts} selected={selection.map((s) => s.key)} resolve={resolve} check={check}
      onAdd={(key, s) => change([...selection, { key, as: s.kind === 'pct' || lines ? 'line' : 'bar' }])} onBundle={loadBundle} />}
    {combine && <div className={styles.combine} role="group" aria-label="Sum into one line">
      <b>Sum into one line</b>
      {combine.terms.map((t, i) => { const s = resolved[selection.findIndex((x) => x.key === t.key)]; return <span key={t.key} className={styles.combineTerm}>
        {i > 0 && <button type="button" className={styles.combineSign} aria-label={`${t.sign > 0 ? 'Adding' : 'Subtracting'} ${s?.label}. Switch`}
          onClick={() => setCombine({ ...combine, terms: combine.terms.map((x) => x.key === t.key ? { ...x, sign: x.sign > 0 ? -1 : 1 } : x) })}>{t.sign > 0 ? '+' : '−'}</button>}
        <span className={styles.combineName}>{s?.label}</span>
      </span>; })}
      <span aria-hidden="true">=</span>
      <label className={styles.srOnly} htmlFor="sum-name">Name of the total</label>
      <input id="sum-name" className={styles.textInput} value={combine.name} maxLength={80} placeholder="Name, e.g. Operating expenses" onChange={(e) => setCombine({ ...combine, name: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') sumInto(combine.terms, combine.name); if (e.key === 'Escape') setCombine(null); }} />
      <button type="button" className={styles.primaryButton} onClick={() => sumInto(combine.terms, combine.name)}>Chart it</button>
      <button type="button" className={styles.ghostButton} onClick={() => setCombine(null)}>Cancel</button>
      <p className={styles.panelNote}>Click + to subtract a line. A quarter where any line is missing shows as a gap.</p>
    </div>}
    {!!chart.omitted.length && <p className={styles.panelNote}>{chart.omitted.map((o) => `${o.label}: ${o.reason.toLowerCase()}`).join(' · ')}</p>}
    <SeriesChart chart={chart} height={260} dashedRight={lines} empty={empty} />
    {!!chart.series.length && <div className={styles.legendScroll}>
      <table className={styles.legendTable}>
        <caption className={styles.srOnly}>Series on the chart: latest value, trend and change on a year earlier</caption>
        <thead><tr>
          <th scope="col">Series</th>
          <th scope="col">Latest{lastPeriod ? ` · ${periodName(lastPeriod)}` : ''}</th>
          <th scope="col">Trend</th>
          <th scope="col">vs a year ago</th>
          {!lines && <th scope="col">Show as</th>}
          <th scope="col"><span className={styles.srOnly}>Remove</span></th>
        </tr></thead>
        <tbody>{chart.series.map((s) => {
          const spec = selection.find((x) => x.key === s.key);
          const terms = parseSumKey(s.key);
          const raw = resolved[selection.findIndex((x) => x.key === s.key)];
          const values = raw?.values ?? [];
          const last = values.findLastIndex((v) => v !== null);
          const now = last >= 0 ? values[last] : null, before = last - lag >= 0 ? values[last - lag] : null;
          const ratio = raw?.kind === 'pct';
          const delta = now === null || before === null ? null : ratio ? now - before : before === 0 ? null : (now - before) / Math.abs(before);
          return <tr key={s.key}>
            <th scope="row"><span className={styles.legendName}>
              <span aria-hidden="true" className={styles.swatch} style={{ background: s.color, borderRadius: s.as === 'line' ? '50%' : 3 }} />
              <span>{s.label}{s.axis === 'right' && <small> · right axis</small>}{terms && spec && <> · <button type="button" className={styles.chipText} onClick={() => split(spec)}>Split</button></>}</span>
            </span></th>
            <td>{raw && now !== null ? formatSeriesValue(now, raw.kind, raw.currency) : '—'}</td>
            <td><Sparkline values={values} color={s.color} /></td>
            <td data-tone={delta === null || Math.abs(delta) < 0.0005 ? undefined : delta > 0 ? 'up' : 'down'}>
              {delta === null ? '—' : ratio ? `${delta >= 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(1)} pts` : `${delta >= 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(1)}%`}</td>
            {!lines && <td>{!s.ratio && !terms ? <span className={styles.miniToggle} role="group" aria-label={`Show ${s.label} as`}>
              {(['bar', 'line'] as const).map((as) => <button key={as} type="button" aria-pressed={s.as === as}
                onClick={() => change(selection.map((x) => (x.key === s.key ? { ...x, as } : x)))}>{as === 'bar' ? 'Bar' : 'Line'}</button>)}
            </span> : <span className={styles.legendMuted}>{terms ? 'Bar' : 'Line'}</span>}</td>}
            <td><button type="button" className={styles.chipRemove} aria-label={`Remove ${s.label}`} onClick={() => change(selection.filter((x) => x.key !== s.key))}><X size={12} aria-hidden="true" /></button></td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <footer className={styles.panelFoot}>
      <span className={styles.linkRow}>
        {!lines && sameUnit && !combine && <button type="button" onClick={() => setCombine({ terms: addable.map((s) => ({ key: s.key, sign: 1 })), name: '' })}>Sum into one line</button>}
        {!!saved.charts.length && <span>Bundles: {saved.charts.map((c, i) => <Fragment key={c.id}>{i > 0 && ' · '}<button type="button" onClick={() => loadBundle(c)} aria-current={title === c.name || undefined}>{c.name}</button></Fragment>)}</span>}
        {!!presets.length && <span>Suggested: {presets.map((p, i) => <Fragment key={p.label}>{i > 0 && ' · '}<button type="button" onClick={() => { change(p.series); setTitle(p.label); }}>{p.label}</button></Fragment>)}</span>}
      </span>
      {!!chart.series.length && <span>Hover a period to read every series. Gaps are periods the filings don’t give.</span>}
    </footer>
    {status && <div role="status" className={status.kind === 'saved' ? styles.toast : styles.errorText}>
      <span>{status.text}</span>{status.kind === 'saved' && <Link href={boardHref} scroll={false}>Open My charts</Link>}
    </div>}
  </section>;
}

/** A small trend line for a legend row; gaps stay gaps. */
function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return <span aria-hidden="true">—</span>;
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const w = 88, h = 22, x = (i: number) => (i / Math.max(1, values.length - 1)) * (w - 4) + 2, y = (v: number) => h - 3 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (h - 6);
  let d = '', pen = false;
  values.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; pen = true; });
  const end = pts[pts.length - 1];
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" /><circle cx={x(end[0])} cy={y(end[1])} r="2.4" fill={color} /></svg>;
}
