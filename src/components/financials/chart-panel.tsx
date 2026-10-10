"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { buildChart, defaultChartName, type ChartRange, type ChartMode, type SeriesSpec } from '@/lib/research/reporting/chart-series';
import type { Frequency, MetricBook, PeriodRef } from '@/lib/research/reporting/metric-catalogue';
import { SeriesChart } from './series-chart';
import type { SavedChartsApi } from './use-saved-charts';
import styles from './financials.module.css';

type Row = Record<string, any>;
export type Preset = { label: string; series: SeriesSpec[] };

export const rangeFor = (count: number): ChartRange => (count <= 4 ? 'last_4' : count <= 8 ? 'last_8' : count <= 12 ? 'last_12' : 'all');

/** Sticky chart of the rows selected in the table below it. */
export function ChartPanel({ observations, frequency, book, periods, selection, onSelection, presets, lines = false, saved, boardHref, label, empty }: {
  observations: Row[]; frequency: Frequency; book: MetricBook; periods: PeriodRef[];
  selection: SeriesSpec[]; onSelection: (next: SeriesSpec[]) => void; presets: Preset[];
  /** Metrics chart every series as a line; statements let each series be a bar or a line. */
  lines?: boolean; saved: SavedChartsApi; boardHref: string; label: string; empty: string;
}) {
  const [title, setTitle] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>('values');
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const chart = useMemo(() => buildChart({ observations, frequency, specs: selection, periods, mode, chartType: lines ? 'lines' : 'bars', book }), [observations, frequency, selection, periods, mode, lines, book]);
  const name = title ?? defaultChartName(chart.series.map((s) => s.label));
  const change = (next: SeriesSpec[]) => { setStatus(null); onSelection(next); };
  const definition = {
    series: chart.series.map((s) => ({ key: s.key, as: selection.find((x) => x.key === s.key)?.as ?? s.as, axis: s.axis })),
    chart_type: lines ? 'lines' as const : 'bars' as const, frequency, range: rangeFor(periods.length), mode,
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
      setStatus({ kind: 'saved', text: `Saved “${name}” to My charts` });
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
      <span className={styles.segmented} role="group" aria-label="Chart values">
        {([['values', 'Values'], ['yoy', 'YoY change']] as const).map(([value, text]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => { setMode(value); setStatus(null); }}>{text}</button>)}
      </span>
      <button type="button" className={styles.ghostButton} onClick={() => { change([]); setTitle(null); }} disabled={!selection.length}>Clear</button>
      <button type="button" className={styles.primaryButton} onClick={() => void save()} disabled={!chart.series.length || saving || isSaved}>{saving ? 'Saving…' : isSaved ? 'Saved' : 'Save to My charts'}</button>
    </div>
    <div className={styles.chips}>
      {chart.series.map((s) => {
        return <span key={s.key} className={styles.chip}>
          <span aria-hidden="true" className={styles.swatch} style={{ background: s.color }} />{s.label}{s.axis === 'right' && <small>right axis</small>}
          {!lines && <span className={styles.miniToggle} role="group" aria-label={`Show ${s.label} as`}>
            {(['bar', 'line'] as const).map((as) => <button key={as} type="button" aria-pressed={s.as === as} disabled={as === 'bar' && s.ratio}
              title={as === 'bar' && s.ratio ? 'Ratios are drawn as lines' : undefined}
              onClick={() => change(selection.map((x) => (x.key === s.key ? { ...x, as } : x)))}>{as === 'bar' ? 'Bar' : 'Line'}</button>)}
          </span>}
          <button type="button" className={styles.chipRemove} aria-label={`Remove ${s.label}`} onClick={() => change(selection.filter((x) => x.key !== s.key))}><X size={12} aria-hidden="true" /></button>
        </span>;
      })}
      {!!presets.length && <span className={styles.presetLabel}>Quick compare:</span>}
      {presets.map((p) => <button key={p.label} type="button" className={styles.preset} onClick={() => { change(p.series); setTitle(p.label); }}>{p.label}</button>)}
    </div>
    {!!chart.omitted.length && <p className={styles.panelNote}>{chart.omitted.map((o) => `${o.label}: ${o.reason.toLowerCase()}`).join(' · ')}</p>}
    <SeriesChart chart={chart} height={230} dashedRight={lines} empty={empty} />
    {status && <div role="status" className={status.kind === 'saved' ? styles.toast : styles.errorText}>
      <span>{status.text}</span>{status.kind === 'saved' && <Link href={boardHref} scroll={false}>Open My charts</Link>}
    </div>}
  </section>;
}
