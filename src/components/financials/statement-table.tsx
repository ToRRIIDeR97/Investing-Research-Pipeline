"use client";

import { Fragment, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { historyMatrix } from '@/lib/research/reporting/presentation.mjs';
import { BASE_INPUTS, evaluateMetric, metricDef, parsePeriod, type MetricBook } from '@/lib/research/reporting/metric-catalogue';
import { METRIC_PREFIX, canAddSeries, resolveSeries, SERIES_COLORS, toggleSeries, type ResolvedSeries, type SeriesSpec } from '@/lib/research/reporting/chart-series';
import type { Frequency } from '@/lib/research/reporting/metric-catalogue';
import { ChartToggle } from './chart-toggle';
import { changeTone, formatAmount, formatChange, isKeyLine, isTotalLine, priorYearLabel, statementTree, unitHeading, unitKind, yearChange, type UnitKind } from './statement-rows';
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

export type Cell = { records: Row[]; text: string; value: number | null };

/** The reported value(s) for one period: one number, several joined by a slash, or why it's missing. */
export function cellFor(row: Row, index: number, kind: UnitKind): Cell {
  const records: Row[] = index < 0 ? [] : row.observations[index] ?? [];
  if (!records.length) return { records, text: '—', value: null };
  const numbers = [...new Set(records.map((r) => r.value_numeric).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number))];
  if (!numbers.length) {
    const reason = records.find((r) => r.metadata_json?.missing_reason)?.metadata_json.missing_reason as string | undefined;
    return { records, text: reason?.startsWith('Not applicable') ? 'Not applicable' : reason ? 'Unavailable' : String(row.values[index]), value: null };
  }
  return { records, text: numbers.map((n) => formatAmount(n, kind)).join(' / '), value: numbers.length === 1 ? numbers[0] : null };
}

/**
 * A statement over the period window (workshop T3). Unit once in the head, one decimal, totals bold
 * over a rule with their parts indented, ratios as small grey rows, and under each value its change
 * on the same period a year earlier. Rows with nothing in the window are hidden behind a link.
 * Each row's chart button charts it alone; shift-click adds it.
 */
export function StatementTable({ rows, group, periods, frequency, observations, book, selection, onSelection, onSources, caption }: {
  rows: Row[]; group: 'income' | 'balance' | 'cashflow'; periods: string[]; frequency: Frequency; observations: Row[]; book: MetricBook;
  selection: SeriesSpec[]; onSelection: (next: SeriesSpec[]) => void; onSources: (rows: Row[], button: HTMLButtonElement) => void; caption: string;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const matrix = useMemo(() => historyMatrix(rows), [rows]);
  const labels = periods.map(periodLabel);
  const refs = periods.map(parsePeriod);
  const selected: ResolvedSeries[] = selection.map((s) => resolveSeries(observations, frequency, s.key, refs, book, s.label));
  const keyCounts = new Map<string, number>();
  for (const r of matrix.rows) keyCounts.set(r.metric_key, (keyCounts.get(r.metric_key) ?? 0) + 1);
  const reported = new Set(rows.map((r) => r.metric_key));

  const kinds = matrix.rows.map((r: Row) => { const first: Row | undefined = r.observations.flat()[0]; return { kind: unitKind(first?.unit, first?.currency), currency: (first?.currency as string) ?? null }; });
  const tally = new Map<string, number>();
  for (const k of kinds) tally.set(`${k.kind}|${k.currency}`, (tally.get(`${k.kind}|${k.currency}`) ?? 0) + 1);
  const [mainKind, mainCurrency] = ([...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other|').split('|') as [UnitKind, string];
  const inWindow = (r: Row) => labels.some((p) => (r.observations[matrix.periods.indexOf(p)] ?? []).length > 0);
  const all = matrix.rows.map((row: Row, i: number) => ({ row, ...kinds[i] }));
  const visible = all.filter(({ row }) => showEmpty || inWindow(row));
  const hidden = all.length - all.filter(({ row }) => inWindow(row)).length;
  const periodKey = periods.join();
  // Totals above their parts, nested by what adds up to what (statementTree).
  const tree = useMemo(() => statementTree(visible.map(({ row, kind, currency }) => ({
    key: row.metric_key, name: row.name, unit: `${kind}|${currency ?? ''}`,
    segment: !!(row.observations.flat()[0]?.segment || row.observations.flat()[0]?.geography),
    // The periods on screen: a company that regrouped its lines years ago still nests by today's grouping.
    values: labels.map((p) => cellFor(row, matrix.periods.indexOf(p), kind).value),
  }))), [matrix, showEmpty, periodKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const idOf = (i: number) => `${visible[i].row.metric_key}|${visible[i].row.basis}|${i}`;
  const hiddenByCollapse = (i: number): boolean => { const p = tree.parent[i]; return p !== null && (collapsed.has(idOf(p)) || hiddenByCollapse(p)); };
  const shownOrder = tree.order.filter((i) => !hiddenByCollapse(i));
  const parentName = (i: number) => { const p = tree.parent[i]; return p === null ? null : visible[p].row.name as string; };
  const parentCount = tree.children.filter((c) => c.length).length;
  const lag = frequency === 'annual' ? 1 : 4;
  const shownDerived = new Set<string>();

  // Rows select and deselect: a click adds the row to the chart or takes it off.
  function toggle(key: string, as: 'bar' | 'line', candidate: ResolvedSeries) {
    return () => onSelection(toggleSeries(selection, key, as, true, canAddSeries(selected, candidate).ok));
  }
  /** A click anywhere on a row toggles it, except on its own buttons (a value opens its sources). */
  function rowClick(key: string, as: 'bar' | 'line', blocked: string | null) {
    return (e: MouseEvent<HTMLTableRowElement>) => {
      if ((e.target as HTMLElement).closest('button, a, input, select') || blocked) return;
      const candidate = resolveSeries(observations, frequency, key, refs, book);
      if (!candidate.reason) toggle(key, as, candidate)();
    };
  }
  function button(key: string, name: string, as: 'bar' | 'line', blocked: string | null) {
    const index = selection.findIndex((s) => s.key === key);
    const candidate = resolveSeries(observations, frequency, key, refs, book);
    const reason = blocked ?? candidate.reason;
    const addReason = index < 0 && selection.length ? canAddSeries(selected, candidate).reason : null;
    return <ChartToggle name={name} color={index >= 0 ? SERIES_COLORS[index % SERIES_COLORS.length] : null} disabled={!!reason} reason={reason ?? addReason}
      hint="Add this row to the chart" onToggle={toggle(key, as, candidate)} />;
  }
  const seriesStyle = (key: string) => { const i = selection.findIndex((s) => s.key === key); return i >= 0 ? { '--series': SERIES_COLORS[i % SERIES_COLORS.length] } as CSSProperties : undefined; };

  function derivedRows(after: string, depth: number) {
    const rule = DERIVED_AFTER.filter((d) => group === 'income' && d.anchors.includes(after) && !d.unless?.some((k) => reported.has(k)));
    return rule.flatMap((d) => d.keys).filter((key) => !shownDerived.has(key) && shownDerived.add(key)).map((key) => {
      const def = metricDef(key)!;
      const results = refs.map((p) => evaluateMetric(book, def, p));
      const seriesKey = `${METRIC_PREFIX}${key}`;
      const on = selection.some((s) => s.key === seriesKey);
      return <tr key={seriesKey} className={styles.derivedRow} data-selected={on || undefined} style={{ ...seriesStyle(seriesKey), '--depth': depth } as CSSProperties}
        onClick={rowClick(seriesKey, def.kind === 'pct' ? 'line' : 'bar', null)}>
        <td className={styles.toggleCell}>{button(seriesKey, def.name, def.kind === 'pct' ? 'line' : 'bar', null)}</td>
        <th scope="row" title={def.formula}>{def.name}</th>
        {results.map((r, i) => <td key={periods[i]} title={r.missing ?? def.formula} data-latest={i === results.length - 1 || undefined}>
          {r.value === null ? '—' : def.kind === 'pct' ? `${(r.value * 100).toFixed(1)}%` : formatAmount(r.value, 'currency')}</td>)}
      </tr>;
    });
  }

  if (!matrix.rows.length) return <p className={styles.panelNote}>No dated observations for this statement and frequency.</p>;
  return <>
    <div className={styles.statementScroll} tabIndex={0} role="region" aria-label={`${caption} table, scroll horizontally for all periods`}>
      <table className={styles.statementTable}>
        <caption className={styles.srOnly}>{caption}. {unitHeading(mainKind, mainCurrency || null)}. Under each value, its change on the same period a year earlier. Each total is followed by the lines that add up to it. Select a row or its chart button to chart it; select a value for exact amounts and sources.</caption>
        <thead><tr>
          <th scope="col" className={styles.toggleCell}><span className={styles.srOnly}>On chart</span></th>
          <th scope="col">{unitHeading(mainKind, mainCurrency || null)} · {frequency === 'annual' ? 'fiscal year' : 'quarter'}</th>
          {labels.map((p, i) => <th scope="col" key={p} data-latest={i === labels.length - 1 || undefined}>{p}</th>)}
        </tr></thead>
        <tbody>{shownOrder.map((index) => {
          const { row, kind, currency } = visible[index];
          const first: Row | undefined = row.observations.flat()[0];
          const blocked = first?.segment || first?.geography ? 'Segment rows are not charted' : (keyCounts.get(row.metric_key) ?? 0) > 1 ? 'Reported on more than one basis' : null;
          const on = selection.some((s) => s.key === row.metric_key) && !blocked;
          const ownUnit = kind !== mainKind || (currency ?? '') !== mainCurrency;
          const note = [ownUnit ? unitHeading(kind, currency) : null, row.basis ? readableBasis(row.basis) : null].filter(Boolean).join(' · ');
          const parts = tree.children[index].length, id = idOf(index), shut = collapsed.has(id);
          const role = isKeyLine(row.metric_key) ? 'key' : parts || isTotalLine(row.name) ? 'total' : tree.depth[index] ? 'child' : 'plain';
          return <Fragment key={id}>
            <tr data-role={role} data-selected={on || undefined} data-clickable={!blocked || undefined} onClick={rowClick(row.metric_key, 'bar', blocked)}
              style={{ ...(on ? seriesStyle(row.metric_key) : {}), '--depth': tree.depth[index] } as CSSProperties}>
              <td className={styles.toggleCell}>{button(row.metric_key, row.name, 'bar', blocked)}</td>
              <th scope="row"><span className={styles.rowName}>
                {parts > 0 ? <button type="button" className={styles.disclose} aria-expanded={!shut} aria-label={`${shut ? 'Show' : 'Hide'} the ${parts} lines that make up ${row.name}`}
                  onClick={() => setCollapsed((c) => { const next = new Set(c); if (next.has(id)) next.delete(id); else next.add(id); return next; })}><ChevronDown size={14} aria-hidden="true" /></button>
                  : <span className={styles.discloseSpace} aria-hidden="true" />}
                <span className={styles.rowLabel}><span className={styles.rowText} title={row.name}>{row.name}</span>{note && <small>{note}</small>}</span>
              </span></th>
              {labels.map((p, i) => {
                const cell = cellFor(row, matrix.periods.indexOf(p), kind);
                const prior = cellFor(row, matrix.periods.indexOf(priorYearLabel(p)), kind);
                const change = kind === 'per_share' || kind === 'currency' || kind === 'shares' ? yearChange(cell.value, prior.value) : null;
                const tone = changeTone(row.name, change, parentName(index));
                return <td key={p} data-negative={cell.value !== null && cell.value < 0 || undefined} data-latest={i === labels.length - 1 || undefined}>
                  {cell.records.length
                    ? <button className={styles.valueButton} onClick={(e) => onSources(cell.records, e.currentTarget)} title={row.exact[matrix.periods.indexOf(p)]}
                      aria-label={`${row.name}, ${p}: ${cell.text}${change === null ? '' : `, ${formatChange(change)} on a year earlier`}. Exact values and sources`}>{cell.text}</button>
                    : <span className={styles.missingValue} title="Not disclosed" aria-label="Not disclosed">—</span>}
                  <small data-tone={tone ?? undefined} aria-hidden="true">{change === null ? '' : formatChange(change)}</small>
                </td>;
              })}
            </tr>
            {!blocked && derivedRows(row.metric_key, tree.depth[index] + 1)}
          </Fragment>;
        })}</tbody>
      </table>
    </div>
    <div className={styles.tableFoot}>
      <span className={styles.tableKey}>
        <span>Each total sits above the lines that add up to it; the arrow folds them.</span>
        <span>Click a row to add it to the chart or take it off; click a number for its source.</span>
        <span>Small figures: change on the same {lag === 4 ? 'quarter' : 'period'} a year earlier.</span>
        <span>Grey rows are worked out from the lines above.</span>
        <span>— means the filing doesn’t give it.</span>
      </span>
      {parentCount > 0 && <button type="button" onClick={() => setCollapsed((c) => c.size ? new Set() : new Set(tree.children.map((k, i) => (k.length && tree.parent[i] !== null ? idOf(i) : null)).filter((x): x is string => !!x)))}>
        {collapsed.size ? 'Expand all' : 'Fold to main totals'}</button>}
      {hidden > 0 && <button type="button" onClick={() => setShowEmpty((v) => !v)} aria-expanded={showEmpty}>{showEmpty ? 'Hide' : 'Show'} {hidden} line{hidden === 1 ? '' : 's'} with no values in these periods</button>}
    </div>
  </>;
}

/** XBRL member names as plain words: "Us-GAAP:Cost Of Sales Member" becomes "Cost Of Sales". */
const readableBasis = (basis: string) => basis.replace(/\b[A-Za-z][\w-]*:/g, '').replace(/ Member\b/g, '').replace(/^GAAP$/, '');
