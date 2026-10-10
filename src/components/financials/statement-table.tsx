"use client";

import { Fragment } from 'react';
import { historyMatrix, number } from '@/lib/research/reporting/presentation.mjs';
import { BASE_INPUTS, evaluateMetric, metricDef, parsePeriod, type MetricBook } from '@/lib/research/reporting/metric-catalogue';
import { METRIC_PREFIX, canAddSeries, resolveSeries, SERIES_COLORS, toggleSeries, type ResolvedSeries, type SeriesSpec } from '@/lib/research/reporting/chart-series';
import type { Frequency } from '@/lib/research/reporting/metric-catalogue';
import { ChartToggle } from './chart-toggle';
import styles from './financials.module.css';

type Row = Record<string, any>;
const periodLabel = (period: string) => (period.includes('-Q') ? `${period.split('-')[1]} ${period.split('-')[0]}` : period);

/** Ratio rows shown inside the income statement, each after the line it is derived from. */
const DERIVED_AFTER: { anchors: string[]; keys: string[]; unless?: string[] }[] = [
  { anchors: BASE_INPUTS.cost_of_revenue.aliases, keys: ['gross_profit', 'gross_margin'], unless: BASE_INPUTS.reported_gross_profit.aliases },
  { anchors: BASE_INPUTS.reported_gross_profit.aliases, keys: ['gross_margin'] },
  { anchors: BASE_INPUTS.operating_income.aliases, keys: ['operating_margin'] },
  { anchors: BASE_INPUTS.net_income.aliases, keys: ['net_margin'] },
];

/**
 * A statement over the period window with a chart button on every row. A click charts the row
 * alone; shift-click adds or removes it (up to six series and two units).
 */
export function StatementTable({ rows, group, periods, frequency, observations, book, selection, onSelection, onSources, caption }: {
  rows: Row[]; group: 'income' | 'balance' | 'cashflow'; periods: string[]; frequency: Frequency; observations: Row[]; book: MetricBook;
  selection: SeriesSpec[]; onSelection: (next: SeriesSpec[]) => void; onSources: (rows: Row[], button: HTMLButtonElement) => void; caption: string;
}) {
  const matrix = historyMatrix(rows);
  const labels = periods.map(periodLabel);
  const refs = periods.map(parsePeriod);
  const units = new Set(matrix.rows.map((r: Row) => [r.unit, r.basis].filter(Boolean).join(' · ')));
  const commonUnit = units.size === 1 ? [...units][0] : null;
  const selected: ResolvedSeries[] = selection.map((s) => resolveSeries(observations, frequency, s.key, refs, book));
  const keyCounts = new Map<string, number>();
  for (const r of matrix.rows) keyCounts.set(r.metric_key, (keyCounts.get(r.metric_key) ?? 0) + 1);
  const reported = new Set(rows.map((r) => r.metric_key));

  function toggle(key: string, as: 'bar' | 'line', candidate: ResolvedSeries) {
    return (additive: boolean) => onSelection(toggleSeries(selection, key, as, additive, canAddSeries(selected, candidate).ok));
  }
  function button(key: string, name: string, as: 'bar' | 'line', blocked: string | null) {
    const index = selection.findIndex((s) => s.key === key);
    const candidate = resolveSeries(observations, frequency, key, refs, book);
    const reason = blocked ?? candidate.reason;
    const addReason = index < 0 && selection.length ? canAddSeries(selected, candidate).reason : null;
    return <ChartToggle name={name} color={index >= 0 ? SERIES_COLORS[index % SERIES_COLORS.length] : null} disabled={!!reason} reason={reason ?? (addReason ? `Shift-click unavailable: ${addReason}` : null)}
      hint="Chart this row; shift-click to add it" onToggle={toggle(key, as, candidate)} />;
  }
  function derivedRows(after: string) {
    const rule = DERIVED_AFTER.filter((d) => group === 'income' && d.anchors.includes(after) && !d.unless?.some((k) => reported.has(k)));
    return rule.flatMap((d) => d.keys).map((key) => {
      const def = metricDef(key)!;
      const results = refs.map((p) => evaluateMetric(book, def, p));
      const seriesKey = `${METRIC_PREFIX}${key}`;
      const on = selection.some((s) => s.key === seriesKey);
      return <tr key={seriesKey} className={styles.derivedRow} data-selected={on || undefined}>
        <td className={styles.toggleCell}>{button(seriesKey, def.name, def.kind === 'pct' ? 'line' : 'bar', null)}</td>
        <th scope="row" title={def.formula}>{def.name}</th>
        {results.map((r, i) => <td key={periods[i]} title={r.missing ?? def.formula} data-negative={r.value !== null && r.value < 0 || undefined}>
          {r.value === null ? '–' : def.kind === 'pct' ? `${(r.value * 100).toFixed(1)}%` : number(r.value / 1e6, 3)}</td>)}
      </tr>;
    });
  }

  if (!matrix.rows.length) return <p className={styles.panelNote}>No dated observations for this statement and frequency.</p>;
  return <div className={styles.statementScroll} tabIndex={0} role="region" aria-label={`${caption} table, scroll horizontally for all periods`}>
    <table className={styles.statementTable}>
      <caption className={styles.srOnly}>{caption}. Use a row’s chart button to chart it; select a value for exact amounts and sources.</caption>
      <thead><tr>
        <th scope="col" className={styles.toggleCell}><span className={styles.srOnly}>On chart</span></th>
        <th scope="col">{commonUnit ? `${commonUnit} · ${frequency === 'annual' ? 'fiscal year' : 'quarter'}` : 'Line item'}</th>
        {labels.map((p) => <th scope="col" key={p}>{p}</th>)}
      </tr></thead>
      <tbody>{matrix.rows.map((row: Row, index: number) => {
        const first: Row | undefined = row.observations.flat()[0];
        const blocked = first?.segment || first?.geography ? 'Segment rows are not charted' : (keyCounts.get(row.metric_key) ?? 0) > 1 ? 'Reported on more than one basis' : null;
        const on = selection.some((s) => s.key === row.metric_key) && !blocked;
        return <Fragment key={index}>
          <tr data-selected={on || undefined} data-strong={/^(revenue|net_revenue|net_income|total_assets|operating_cash_flow|us_gaap_OperatingIncomeLoss)$/.test(row.metric_key) || undefined}>
            <td className={styles.toggleCell}>{button(row.metric_key, row.name, 'bar', blocked)}</td>
            <th scope="row">{row.name}{!commonUnit && <small>{row.unit}{row.basis ? ` · ${readableBasis(row.basis)}` : ''}</small>}</th>
            {labels.map((p) => {
              const i = matrix.periods.indexOf(p);
              const records: Row[] = row.observations[i] ?? [];
              const display = records.length && records.every((r) => r.value_numeric == null) && records.some((r) => r.metadata_json?.missing_reason)
                ? (records.some((r) => r.metadata_json?.missing_reason?.startsWith('Not applicable')) ? 'Not applicable' : 'Unavailable') : row.values[i];
              const negative = records.length === 1 && Number(records[0].value_numeric) < 0;
              return <td key={p} data-negative={negative || undefined}>{records.length
                ? <button className={styles.valueButton} onClick={(e) => onSources(records, e.currentTarget)} title={row.exact[i]} aria-label={`${row.name}, ${p}: ${display}. Exact values and sources`}>{display}</button>
                : <span className={styles.missingValue} title="Not disclosed" aria-label="Not disclosed">–</span>}</td>;
            })}
          </tr>
          {!blocked && derivedRows(row.metric_key)}
        </Fragment>;
      })}</tbody>
    </table>
  </div>;
}


/** XBRL member names as plain words: "Us-GAAP:Cost Of Sales Member" becomes "Cost Of Sales". */
const readableBasis = (basis: string) => basis.replace(/\b[A-Za-z][\w-]*:/g, '').replace(/ Member\b/g, '');
