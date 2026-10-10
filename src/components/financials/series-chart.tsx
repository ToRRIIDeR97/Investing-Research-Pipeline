"use client";

import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatAxis, formatSeriesValue, type BuiltChart } from '@/lib/research/reporting/chart-series';
import { periodName } from '@/lib/research/reporting/metric-catalogue';
import styles from './financials.module.css';

const TICK = { fontSize: 11, fill: '#626b78' };

/** Bars and lines over fiscal periods; missing values are gaps, never zero. */
export function SeriesChart({ chart, height = 230, compact = false, dashedRight = false, empty = 'Nothing to chart yet.' }: { chart: BuiltChart; height?: number; compact?: boolean; dashedRight?: boolean; empty?: string }) {
  if (!chart.series.length) return <div className={styles.chartEmpty} style={{ height }}>{empty}</div>;
  const negative = chart.series.some((s) => s.axis === 'left' && s.values.some((v) => v !== null && v < 0));
  const first = chart.periods[0], last = chart.periods.at(-1);
  const summary = `${chart.series.map((s) => s.label).join(', ')}${chart.mode === 'yoy' ? ', change on a year earlier' : ''}${first && last ? `, ${periodName(first)} to ${periodName(last)}` : ''}.`;
  return <div className={styles.chartCanvas} style={{ height }} role="img" aria-label={`Chart of ${summary}`}>
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={chart.data} margin={{ top: 10, right: compact ? 2 : 6, bottom: 0, left: compact ? -6 : 0 }} barGap={3} barCategoryGap="24%" accessibilityLayer={false}>
        <CartesianGrid vertical={false} stroke="#edeff0" />
        <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: '#cbd0d5' }} tick={{ ...TICK, fontSize: compact ? 10 : 11 }} interval="preserveStartEnd" minTickGap={6} />
        <YAxis yAxisId="left" width={compact ? 48 : 58} axisLine={false} tickLine={false} tick={{ ...TICK, fontSize: compact ? 10 : 11 }}
          domain={chart.left ? [chart.left.scale.lo, chart.left.scale.hi] : [0, 1]} ticks={chart.left?.scale.ticks} interval={0}
          tickFormatter={(v: number) => chart.left ? formatAxis(v, chart.left.kind, chart.left.currency) : String(v)} />
        {chart.right && <YAxis yAxisId="right" orientation="right" width={compact ? 40 : 48} axisLine={false} tickLine={false} tick={{ ...TICK, fontSize: compact ? 10 : 11 }}
          domain={[chart.right.scale.lo, chart.right.scale.hi]} ticks={chart.right.scale.ticks} interval={0}
          tickFormatter={(v: number) => formatAxis(v, chart.right!.kind, chart.right!.currency)} />}
        {negative && <ReferenceLine yAxisId="left" y={0} stroke="#9aa1ab" />}
        <Tooltip cursor={{ fill: 'rgba(81,93,112,.07)' }} isAnimationActive={false} content={({ active, label }) => {
          if (!active) return null;
          const index = chart.data.findIndex((d) => d.label === label);
          if (index < 0) return null;
          return <div className={styles.tooltip}>
            <p>{periodName(chart.periods[index])}{chart.mode === 'yoy' ? ' · change on a year earlier' : ''}</p>
            {chart.series.map((s) => <div key={s.key}><span aria-hidden="true" style={{ background: s.color }} /><span>{s.label}</span><b>{formatSeriesValue(s.values[index], s.kind, s.currency)}</b></div>)}
          </div>;
        }} />
        {chart.series.map((s, i) => s.as === 'bar'
          ? <Bar key={s.key} yAxisId={s.axis} dataKey={`s${i}`} name={s.label} fill={s.color} stackId={s.stack} radius={s.stack ? 0 : [2, 2, 0, 0]} maxBarSize={compact ? 22 : 30} isAnimationActive={false} />
          : <Line key={s.key} yAxisId={s.axis} dataKey={`s${i}`} name={s.label} type="linear" stroke={s.color} strokeWidth={2} strokeDasharray={dashedRight && s.axis === 'right' ? '5 4' : undefined}
              dot={{ r: compact ? 2.5 : 3.5, fill: '#fff', stroke: s.color, strokeWidth: 2 }} activeDot={{ r: 4.5 }} connectNulls={false} isAnimationActive={false} />)}
      </ComposedChart>
    </ResponsiveContainer>
  </div>;
}

/** Legend swatches; right-axis series are labelled. */
export function ChartLegend({ chart }: { chart: BuiltChart }) {
  return <ul className={styles.legend}>{chart.series.map((s) => <li key={s.key}>
    <span aria-hidden="true" style={{ background: s.color, borderRadius: s.as === 'line' ? '50%' : 2 }} />{s.label}{s.axis === 'right' && chart.left ? <small> (right axis)</small> : null}
  </li>)}</ul>;
}
