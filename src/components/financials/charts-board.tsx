"use client";

import { useMemo, useRef, useState } from 'react';
import { Maximize2, MoreHorizontal, X } from 'lucide-react';
import { RANGE_PERIODS, buildChart, canAddSeries, chartTakeaway, resolveSeries, type ChartRange, type ChartType, type SeriesSpec } from '@/lib/research/reporting/chart-series';
import type { Frequency, MetricBook, PeriodRef } from '@/lib/research/reporting/metric-catalogue';
import type { SavedChart, SavedChartDefinition } from '@/lib/research/reporting/saved-charts';
import { ChartLegend, SeriesChart } from './series-chart';
import type { SavedChartsApi } from './use-saved-charts';
import styles from './financials.module.css';

type Row = Record<string, any>;
export type SeriesOptionGroup = { group: string; options: { key: string; label: string }[] };

const TYPES: [ChartType, string][] = [['bars', 'Bars'], ['stacked', 'Stacked'], ['lines', 'Lines']];
const rangeText = (range: ChartRange, frequency: Frequency) => range === 'all' ? 'all periods' : `last ${RANGE_PERIODS[range]} ${frequency === 'annual' ? 'years' : 'quarters'}`;
const periodsFor = (all: PeriodRef[], range: ChartRange) => (range === 'all' ? all : all.slice(-RANGE_PERIODS[range]));

/**
 * Saved charts filled with the current asset's observations. The page frequency applies to
 * every card; each card keeps its own chart type.
 */
export function ChartsBoard({ observations, frequency, book, periods, saved, options }: {
  observations: Row[]; frequency: Frequency; book: MetricBook; periods: PeriodRef[]; saved: SavedChartsApi; options: SeriesOptionGroup[];
}) {
  return <>
    {saved.error && <p role="alert" className={styles.errorText}>{saved.error}</p>}
    {saved.loaded && !saved.charts.length && !saved.error && <p className={styles.panelNote}>No saved charts yet. Chart rows in a statement or the metrics and choose “Save to My charts”, or build one below.</p>}
    <div className={styles.board}>
      {saved.charts.map((chart) => <ChartCard key={chart.id} chart={chart} observations={observations} frequency={frequency} book={book} periods={periods} saved={saved} />)}
      <ChartBuilder observations={observations} frequency={frequency} book={book} periods={periods} saved={saved} options={options} />
    </div>
    <p className={styles.panelNote}>Saved charts follow the company: open another asset and the same board fills with its numbers. Each card keeps its own chart type; the Quarterly/Annual toggle switches every card where the data exists. Saved charts are shared by everyone using this Research OS instance.</p>
  </>;
}

function ChartCard({ chart, observations, frequency, book, periods, saved }: { chart: SavedChart; observations: Row[]; frequency: Frequency; book: MetricBook; periods: PeriodRef[]; saved: SavedChartsApi }) {
  const def = chart.definition;
  const shown = useMemo(() => periodsFor(periods, def.range), [periods, def.range]);
  const built = useMemo(() => buildChart({ observations, frequency, book, specs: def.series, periods: shown, mode: def.mode, chartType: def.chart_type }), [observations, frequency, book, def, shown]);
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } };
  const sub = `${frequency === 'annual' ? 'Annual' : 'Quarterly'} · ${rangeText(def.range, frequency)}${def.chart_type === 'stacked' ? ' · stacked' : ''}${def.mode === 'yoy' ? ' · change on a year earlier' : ''}`;
  return <article className={styles.card}>
    <header className={styles.cardHead}>
      <div>
        {renaming === null ? <h2>{chart.name}</h2> : <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await saved.update(chart.id, { name: renaming }); setRenaming(null); }); }}>
          <label className={styles.srOnly} htmlFor={`rename-${chart.id}`}>Chart name</label>
          <input id={`rename-${chart.id}`} className={styles.textInput} value={renaming} maxLength={120} autoFocus onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }} />
        </form>}
        <p>{sub}</p>
      </div>
      <button type="button" className={styles.iconButton} aria-label={`Open ${chart.name} larger`} onClick={() => dialog.current?.showModal()}><Maximize2 size={15} aria-hidden="true" /></button>
      <details ref={menu} className={styles.cardMenu} onToggle={(e) => { if (!(e.currentTarget as HTMLDetailsElement).open) setConfirming(false); }}>
        <summary className={styles.iconButton} aria-label={`More actions for ${chart.name}`}><MoreHorizontal size={16} aria-hidden="true" /></summary>
        <div role="menu">
          <button type="button" role="menuitem" onClick={() => { setRenaming(chart.name); if (menu.current) menu.current.open = false; }}>Rename</button>
          {confirming
            ? <button type="button" role="menuitem" className={styles.danger} onClick={() => void act(() => saved.remove(chart.id))}>Confirm delete</button>
            : <button type="button" role="menuitem" onClick={() => setConfirming(true)}>Delete chart</button>}
        </div>
      </details>
    </header>
    <ChartLegend chart={built} />
    <SeriesChart chart={built} height={180} compact empty="None of these series is captured for this company." />
    {!!built.omitted.length && <p className={styles.panelNote}>Not shown: {built.omitted.map((o) => `${o.label} (${o.reason.toLowerCase()})`).join(', ')}.</p>}
    {error && <p role="alert" className={styles.errorText}>{error}</p>}
    <footer className={styles.cardFoot}>
      <span>{chartTakeaway(built, frequency)}</span>
      <span className={styles.segmentedSmall} role="group" aria-label={`Chart type for ${chart.name}`}>
        {TYPES.map(([type, text]) => <button key={type} type="button" aria-pressed={def.chart_type === type}
          onClick={() => { if (def.chart_type !== type) void act(() => saved.update(chart.id, { definition: { ...def, chart_type: type } })); }}>{text}</button>)}
      </span>
    </footer>
    <dialog ref={dialog} className={styles.chartDialog} aria-label={chart.name}>
      <header><h2>{chart.name}</h2><button type="button" className={styles.iconButton} aria-label="Close" onClick={() => dialog.current?.close()}><X size={18} aria-hidden="true" /></button></header>
      <p className={styles.panelNote}>{sub}</p>
      <ChartLegend chart={built} />
      <SeriesChart chart={built} height={420} empty="None of these series is captured for this company." />
    </dialog>
  </article>;
}

function ChartBuilder({ observations, frequency, book, periods, saved, options }: { observations: Row[]; frequency: Frequency; book: MetricBook; periods: PeriodRef[]; saved: SavedChartsApi; options: SeriesOptionGroup[] }) {
  const [name, setName] = useState('');
  const [series, setSeries] = useState<SeriesSpec[]>([]);
  const [type, setType] = useState<ChartType>('bars');
  const [range, setRange] = useState<ChartRange>('last_8');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const labelOf = new Map(options.flatMap((g) => g.options.map((o) => [o.key, o.label] as const)));
  const resolve = (key: string) => resolveSeries(observations, frequency, key, periods.slice(-8), book);
  function add(key: string) {
    setError(null);
    if (!key || series.some((s) => s.key === key)) return;
    const candidate = resolve(key);
    const check = canAddSeries(series.map((s) => resolve(s.key)), candidate);
    if (!check.ok) { setError(check.reason); return; }
    setSeries([...series, { key, as: candidate.kind === 'pct' ? 'line' : 'bar' }]);
  }
  async function save() {
    setError(null);
    if (!name.trim()) { setError('Name the chart.'); return; }
    if (!series.length) { setError('Add at least one series.'); return; }
    const built = buildChart({ observations, frequency, book, specs: series, periods: periods.slice(-8) });
    const definition: SavedChartDefinition = { series: series.map((s) => ({ ...s, axis: built.series.find((b) => b.key === s.key)?.axis ?? 'left' })), chart_type: type, frequency, range, mode: 'values' };
    setSaving(true);
    try { await saved.create(name, definition); setName(''); setSeries([]); setType('bars'); setRange('last_8'); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  const unit = frequency === 'annual' ? 'years' : 'quarters';
  return <section id="new-chart" className={styles.builder} aria-labelledby="new-chart-title">
    <h2 id="new-chart-title">New chart</h2>
    <label htmlFor="new-chart-name">Name</label>
    <input id="new-chart-name" className={styles.textInput} value={name} maxLength={120} placeholder="For example, R&D vs operating income" onChange={(e) => setName(e.target.value)} />
    <span className={styles.fieldLabel} id="new-chart-series">Series</span>
    <div className={styles.chips} aria-labelledby="new-chart-series">
      {series.map((s) => <span key={s.key} className={styles.chip}>{labelOf.get(s.key) ?? s.key}
        <span className={styles.miniToggle} role="group" aria-label={`Show ${labelOf.get(s.key)} as`}>
          {(['bar', 'line'] as const).map((as) => <button key={as} type="button" aria-pressed={s.as === as} onClick={() => setSeries(series.map((x) => (x.key === s.key ? { ...x, as } : x)))}>{as === 'bar' ? 'Bar' : 'Line'}</button>)}
        </span>
        <button type="button" className={styles.chipRemove} aria-label={`Remove ${labelOf.get(s.key)}`} onClick={() => setSeries(series.filter((x) => x.key !== s.key))}><X size={12} aria-hidden="true" /></button>
      </span>)}
      <label className={styles.srOnly} htmlFor="new-chart-add">Add series</label>
      <select id="new-chart-add" className={styles.addSeries} value="" onChange={(e) => add(e.target.value)} disabled={series.length >= 6}>
        <option value="">{series.length >= 6 ? 'Six series at most' : 'Add series…'}</option>
        {options.map((g) => <optgroup key={g.group} label={g.group}>{g.options.map((o) => <option key={o.key} value={o.key} disabled={series.some((s) => s.key === o.key)}>{o.label}</option>)}</optgroup>)}
      </select>
    </div>
    <span className={styles.fieldLabel}>Chart type</span>
    <span className={styles.segmentedSmall} role="group" aria-label="Chart type">
      {TYPES.map(([value, text]) => <button key={value} type="button" aria-pressed={type === value} onClick={() => setType(value)}>{value === 'bars' ? 'Bars + lines' : text}</button>)}
    </span>
    <span className={styles.fieldLabel}>Periods</span>
    <span className={styles.segmentedSmall} role="group" aria-label="Periods">
      {(['last_8', 'last_12', 'all'] as const).map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{value === 'all' ? 'All' : `Last ${RANGE_PERIODS[value]} ${unit}`}</button>)}
    </span>
    {error && <p role="alert" className={styles.errorText}>{error}</p>}
    <div className={styles.builderActions}>
      <button type="button" className={styles.primaryButton} onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save to board'}</button>
      <button type="button" className={styles.ghostButton} onClick={() => { setName(''); setSeries([]); setError(null); }}>Cancel</button>
    </div>
  </section>;
}
