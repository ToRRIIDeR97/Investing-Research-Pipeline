"use client";

import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { safeUrl } from '@/lib/research/reporting/presentation.mjs';
import { METRICS, METRIC_GROUPS, evaluateMetric, formatInput, formatMetric, periodKey, periodName, shiftPeriod, yearLag, yearOverYear,
  type Frequency, type MetricBook, type MetricResult, type PeriodRef } from '@/lib/research/reporting/metric-catalogue';
import { CHART_PRESETS, METRIC_PREFIX, SERIES_COLORS, canAddSeries, resolveSeries, toggleSeries, type SeriesSpec } from '@/lib/research/reporting/chart-series';
import { ChartPanel } from './chart-panel';
import { ChartToggle } from './chart-toggle';
import type { SavedChartsApi } from './use-saved-charts';
import styles from './financials.module.css';

type Row = Record<string, any>;
type Filter = 'all' | 'available' | 'missing';

const marks = (r: MetricResult) => `${r.derivedQuarter ? '†' : ''}${r.unverified ? '‡' : ''}`;

/** The 39-metric catalogue: grouped tables, a formula drawer and the shared chart panel. */
export function MetricsView({ observations, frequency, book, periods, chartPeriods, saved, boardHref }: {
  observations: Row[]; frequency: Frequency; book: MetricBook; periods: PeriodRef[]; chartPeriods: PeriodRef[]; saved: SavedChartsApi; boardHref: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<SeriesSpec[]>(() =>
    ['operating_margin', 'fcf_margin', 'roic'].map((k) => ({ key: `${METRIC_PREFIX}${k}`, as: 'line' as const })));
  const latest = periods.at(-1);
  const [pick, setPick] = useState<{ key: string; period: string } | null>(null);

  const table = useMemo(() => METRICS.map((def) => {
    const results = periods.map((p) => evaluateMetric(book, def, p));
    const prior = latest ? evaluateMetric(book, def, shiftPeriod(latest, -yearLag(frequency))) : null;
    return { def, results, change: yearOverYear(results.at(-1)?.value ?? null, prior?.value ?? null, def.kind), available: results.some((r) => r.value !== null) };
  }), [book, periods, latest, frequency]);
  const availableCount = table.filter((m) => m.available).length;
  const shown = table.filter((m) => filter === 'all' || (filter === 'available') === m.available);
  const selected = useMemo(() => selection.map((s) => resolveSeries(observations, frequency, s.key, chartPeriods, book)), [selection, observations, frequency, chartPeriods, book]);

  const pickKey = pick?.key ?? 'operating_margin';
  const pickPeriod = periods.find((p) => periodKey(p) === pick?.period) ?? latest;
  const detail = pickPeriod ? evaluateMetric(book, METRICS.find((m) => m.key === pickKey) ?? METRICS[0], pickPeriod) : null;
  const presets = CHART_PRESETS.metrics;
  const anyDerived = table.some((m) => m.results.some((r) => r.derivedQuarter)), anyUnverified = table.some((m) => m.results.some((r) => r.unverified));

  return <>
    <ChartPanel observations={observations} frequency={frequency} book={book} periods={chartPeriods} selection={selection} onSelection={setSelection} presets={presets} lines
      saved={saved} boardHref={boardHref} label="Chart of selected metrics" empty="Press the chart button next to any metric to plot it." />
    <div className={styles.metricsToolbar}>
      <span role="group" aria-label="Show metrics" className={styles.filters}>
        {([['all', `All ${table.length}`], ['available', `Available ${availableCount}`], ['missing', `Needs data ${table.length - availableCount}`]] as const)
          .map(([value, text]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{text}</button>)}
      </span>
      <p className={styles.panelNote}>
        {anyDerived && <span>† uses a quarter derived as the fiscal-year total minus the other three quarters. </span>}
        {anyUnverified && <span>‡ uses a period-end price that was not cross-checked against a second source. </span>}
        Select a value for its formula and inputs.
      </p>
    </div>
    <div className={styles.metricsLayout}>
      <div className={styles.metricGroups}>
        {METRIC_GROUPS.map((group) => {
          const items = shown.filter((m) => m.def.group === group);
          if (!items.length) return null;
          const open = !closed[group], missing = items.filter((m) => !m.available).length;
          return <section key={group} className={styles.metricGroup}>
            <h2><button type="button" aria-expanded={open} onClick={() => setClosed((c) => ({ ...c, [group]: !c[group] }))}>
              <ChevronRight size={14} aria-hidden="true" className={styles.chevron} />
              <span>{group}</span>
              <small>{items.length} metric{items.length > 1 ? 's' : ''}{missing ? ` · ${missing} need data` : ''}</small>
            </button></h2>
            {open && <div className={styles.metricScroll}><table className={styles.metricTable}>
              <thead><tr>
                <th scope="col" className={styles.toggleCell}><span className={styles.srOnly}>On chart</span></th>
                <th scope="col">Metric</th>
                {periods.map((p) => <th scope="col" key={periodKey(p)}>{periodName(p)}</th>)}
                <th scope="col">vs a year ago</th>
              </tr></thead>
              <tbody>{items.map(({ def, results, change, available }) => {
                const key = `${METRIC_PREFIX}${def.key}`, index = selection.findIndex((s) => s.key === key);
                const candidate = { kind: def.kind, currency: results.find((r) => r.currency)?.currency ?? null };
                const add = index < 0 ? canAddSeries(selected, candidate) : { ok: true, reason: null };
                const reason = !available ? 'No values to chart' : add.reason;
                return <tr key={def.key} data-selected={index >= 0 || undefined}>
                  <td className={styles.toggleCell} style={index >= 0 ? { boxShadow: `inset 3px 0 0 ${SERIES_COLORS[index % SERIES_COLORS.length]}` } : undefined}>
                    <ChartToggle name={def.name} icon="line" color={index >= 0 ? SERIES_COLORS[index % SERIES_COLORS.length] : null} disabled={index < 0 && !!reason} reason={reason}
                      hint="Add to chart" onToggle={() => setSelection(toggleSeries(selection, key, 'line', true, add.ok))} />
                  </td>
                  <th scope="row">{def.name}</th>
                  {results.map((r) => {
                    const on = detail?.key === def.key && pickPeriod && periodKey(r.period) === periodKey(pickPeriod);
                    const text = formatMetric(r.value, def.kind, r.currency, def.digits);
                    return <td key={periodKey(r.period)}><button type="button" className={styles.metricValue} aria-pressed={!!on} data-missing={r.value === null || undefined} data-negative={r.value !== null && r.value < 0 || undefined}
                      aria-label={`${def.name}, ${periodName(r.period)}: ${r.value === null ? `unavailable. ${r.missing}` : text}${r.unverified ? ', price not cross-checked' : ''}. Show formula and inputs`}
                      onClick={() => setPick({ key: def.key, period: periodKey(r.period) })}>{text}{marks(r) && <sup>{marks(r)}</sup>}</button></td>;
                  })}
                  <td className={styles.change} data-tone={!change || Math.abs(change.diff) < 0.05 || def.up === undefined ? 'neutral' : (change.diff > 0) === def.up ? 'good' : 'bad'}>{change?.text ?? 'n/a'}</td>
                </tr>;
              })}</tbody>
            </table></div>}
          </section>;
        })}
      </div>
      {detail && <MetricDetail result={detail} frequency={frequency} />}
    </div>
  </>;
}

function MetricDetail({ result, frequency }: { result: MetricResult; frequency: Frequency }) {
  const sources = new Map<string, string>();
  for (const input of result.inputs) for (const row of input.rows) {
    const url = safeUrl(row.metadata_json?.source_url);
    if (url && !sources.has(url)) sources.set(url, row.metadata_json?.form ? `${row.metadata_json.form} · ${row.period_end ?? periodName({ year: row.fiscal_year, quarter: row.fiscal_quarter ?? null })}`
      : row.metadata_json?.metric_category === 'market_data' ? `Price history · ${row.metadata_json?.source_locator?.trading_date ?? row.period_end ?? ''}` : `Filing · ${row.period_end ?? row.fiscal_year}`);
  }
  const evidence = [...new Set(result.inputs.flatMap((i) => i.rows.map((r) => r.metadata_json?.evidence).filter(Boolean)))] as string[];
  return <aside className={styles.detail} aria-label="Metric detail" aria-live="polite">
    <p className={styles.detailMeta}>{result.group} · {periodName(result.period)}{frequency === 'quarterly' ? '' : ' (fiscal year)'}</p>
    <h2>{result.name}</h2>
    <p className={styles.detailValue} data-missing={result.value === null || undefined}>{formatMetric(result.value, result.kind, result.currency, result.digits)}</p>
    {result.value === null && result.missing && <p className={styles.detailMissing}>Unavailable: {result.missing}.</p>}
    {result.unverified && <p className={styles.badge}>Unverified price: the period-end close was not cross-checked against a second source.</p>}
    <div className={styles.formula}><span>Formula</span>{result.formula}</div>
    <h3>Inputs</h3>
    <table className={styles.inputs}><tbody>{result.inputs.map((input, i) => <tr key={i}>
      <th scope="row">{input.label}<small>{input.basis}</small></th>
      <td data-missing={input.value === null || undefined}>{formatInput(input)}{input.derivedQuarter ? ' †' : ''}{input.unverified ? ' ‡' : ''}</td>
    </tr>)}</tbody></table>
    {result.note && <p className={styles.detailNote}>{result.note}</p>}
    {evidence.map((quote) => <blockquote key={quote} className={styles.detailQuote}>{quote}</blockquote>)}
    {!!sources.size && <><h3>Sources</h3><ul className={styles.sourceList}>{[...sources].map(([url, text]) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{text}</a></li>)}</ul></>}
  </aside>;
}
