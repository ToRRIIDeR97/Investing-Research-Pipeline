"use client";

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { SERIES_COLORS, type ResolvedSeries } from '@/lib/research/reporting/chart-series';
import type { SavedChart } from '@/lib/research/reporting/saved-charts';
import type { SeriesOptionGroup } from './charts-board';
import { matches } from './statement-rows';
import styles from './financials.module.css';

type Result =
  | { type: 'bundle'; chart: SavedChart }
  | { type: 'item'; key: string; label: string; group: string };

/**
 * The chart's command bar: type to find a line item, ratio or saved bundle and add it with Enter.
 * Bundles come first. `/` focuses it when no other field has focus.
 */
export function SeriesSearch({ options, bundles, selected, resolve, check, onAdd, onBundle }: {
  options: SeriesOptionGroup[]; bundles: SavedChart[]; selected: string[];
  /** Latest value and availability for a result row. */
  resolve: (key: string) => ResolvedSeries;
  /** Why a series can't join the chart, if it can't. */
  check: (series: ResolvedSeries) => string | null;
  onAdd: (key: string, series: ResolvedSeries) => void; onBundle: (chart: SavedChart) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  const results: Result[] = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const found: Result[] = bundles.filter((b) => matches(b.name, q)).slice(0, 4).map((chart) => ({ type: 'bundle', chart }));
    for (const g of options) for (const o of g.options) if (matches(o.label, q) && found.length < 12) found.push({ type: 'item', key: o.key, label: o.label, group: g.group });
    return found;
  }, [query, options, bundles]);
  const rows = useMemo(() => results.map((r) => {
    if (r.type === 'bundle') return { r, blocked: null as string | null, latest: null as string | null };
    if (selected.includes(r.key)) return { r, blocked: 'On the chart', latest: null };
    const s = resolve(r.key);
    const last = s.values.findLast((v) => v !== null);
    return { r, blocked: s.reason ?? check(s), latest: last == null ? null : formatLatest(last, s) };
  }), [results, selected, resolve, check]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      e.preventDefault();
      input.current?.focus();
    };
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, []);

  function pick(index: number) {
    const row = rows[index];
    if (!row || row.blocked) return;
    if (row.r.type === 'bundle') onBundle(row.r.chart);
    else onAdd(row.r.key, resolve(row.r.key));
    setQuery('');
    setActive(0);
    input.current?.focus();
  }

  const showList = open && query.trim().length > 0;
  return <div className={styles.command} ref={box}>
    <label className={styles.commandField}>
      <Search size={16} aria-hidden="true" />
      <span className={styles.srOnly}>Add a line item or bundle</span>
      <input ref={input} role="combobox" aria-expanded={showList} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={showList && rows[active] ? `${id}-${active}` : undefined}
        value={query} placeholder="Add a line item or bundle: revenue, cash flow, sales and marketing…" autoComplete="off"
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
          else if (e.key === 'Escape') { setQuery(''); setOpen(false); }
        }} />
      <kbd aria-hidden="true">/</kbd>
    </label>
    {showList && <div className={styles.commandPop} id={`${id}-list`} role="listbox" aria-label="Line items and bundles">
      {!rows.length && <p className={styles.commandEmpty}>Nothing matches “{query.trim()}”. Try “income”, “cash” or “expense”.</p>}
      {rows.map(({ r, blocked, latest }, i) => <div key={r.type === 'bundle' ? `b-${r.chart.id}` : r.key} id={`${id}-${i}`} role="option" aria-selected={i === active} aria-disabled={!!blocked || undefined}
        className={styles.commandRow} data-active={i === active || undefined} onPointerDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
        {r.type === 'bundle'
          ? <><span className={styles.commandIcon} data-kind="bundle" aria-hidden="true">B</span>
            <span><b>{r.chart.name}</b><small>Bundle · {r.chart.definition.series.length} line items</small></span>
            <span className={styles.bundleDots} aria-hidden="true">{r.chart.definition.series.map((_, j) => <i key={j} style={{ background: SERIES_COLORS[j % SERIES_COLORS.length] }} />)}</span></>
          : <><span className={styles.commandIcon} aria-hidden="true">{r.key.startsWith('metric:') ? '%' : '$'}</span>
            <span><b>{r.label}</b><small>{r.group}{blocked ? ` · ${blocked}` : ''}</small></span>
            <span className={styles.commandValue}>{latest ?? ''}</span></>}
      </div>)}
    </div>}
  </div>;
}

function formatLatest(value: number, s: ResolvedSeries) {
  if (s.kind === 'pct') return `${(value * 100).toFixed(1)}%`;
  if (s.kind === 'x') return `${value.toFixed(1)}×`;
  if (s.kind === 'money') {
    const a = Math.abs(value), sign = value < 0 ? '−' : '';
    return a >= 1e9 ? `${sign}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${sign}$${(a / 1e6).toFixed(0)}M` : `${sign}$${a.toLocaleString('en-US')}`;
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
