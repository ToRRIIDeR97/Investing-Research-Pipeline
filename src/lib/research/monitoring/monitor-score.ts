/**
 * Score a run's monitoring dashboard against statements captured from filings newer than the run. Pure: no
 * database, network or model. An item is scored only from a new filing's reading; an item without one is
 * not_checkable, never healthy, so a stale analyst level cannot pass for a fresh check.
 */
import { kpiStatus, type KpiStatus } from "../reporting/kpi-health";
import { kpiSeries, parseUnit } from "../reporting/dashboard-series";
import { MetricBook, evaluateMetric, metricDef, type PeriodRef } from "../reporting/metric-catalogue";

type Row = Record<string, any>;

export type MonitorStatus = KpiStatus | "not_checkable";
export interface MonitorItemResult {
  kpi: string;
  metric_key: string | null;
  status: MonitorStatus;
  value: number | null;
  period: string | null;
  bear_threshold: number | null;
  bull_threshold: number | null;
  reason: string;
}

/** Ratios the dashboard names that the metric catalogue lacks, built from the same statement inputs. */
const MONITOR_RATIOS: { match: RegExp; inputs: [string, string]; name: string }[] = [
  { match: /^capex_(intensity|pct_revenue|to_revenue|percent_of_revenue)/, inputs: ["capex", "revenue"], name: "Capital expenditure ÷ revenue" },
];

const quarterKey = (p: PeriodRef) => `${p.year}-Q${p.quarter}`;
const num = (value: unknown) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/** A catalogue ratio is a decimal; a dashboard item may state its thresholds in percent. */
function inItemUnits(value: number, item: Row): number {
  const percent = parseUnit(item.unit)?.base === "%";
  const scale = Math.max(Math.abs(num(item.bear_threshold) ?? 0), Math.abs(num(item.bull_threshold) ?? 0));
  return percent && scale > 1.5 ? value * 100 : value;
}

function ratioReading(item: Row, book: MetricBook, periods: PeriodRef[]): { value: number; period: string } | null {
  const key = String(item.metric_key ?? "");
  const def = metricDef(key);
  const ratio = MONITOR_RATIOS.find(r => r.match.test(key));
  if (!def && !ratio) return null;
  for (const p of periods) {
    let value: number | null = null;
    if (def) value = evaluateMetric(book, def, p).value;
    else {
      const [a, b] = ratio!.inputs.map(name => book.get(name, p));
      if (a.value !== null && b.value !== null && b.value > 0 && a.currency === b.currency) value = Math.abs(a.value) / b.value;
    }
    if (value !== null) return { value: inItemUnits(value, item), period: quarterKey(p) };
  }
  return null;
}

/**
 * newObservations: statement rows from the new filings only. context: the run's earlier observations, which a
 * catalogue metric may need (trailing twelve months, averages); a reading is still taken only for a new period.
 */
export function scoreDashboard(items: Row[], newObservations: Row[], context: Row[] = []): MonitorItemResult[] {
  const newPeriods = [...new Set(newObservations.filter(o => o.periodicity === "quarterly" && o.fiscal_quarter)
    .map(o => quarterKey({ year: o.fiscal_year, quarter: o.fiscal_quarter })))].sort().reverse();
  const periodRefs = newPeriods.map(key => ({ year: Number(key.slice(0, 4)), quarter: Number(key.slice(-1)) }));
  const observations = [...newObservations, ...context];
  const book = new MetricBook(observations, "quarterly");
  return items.map((item): MonitorItemResult => {
    const base = { kpi: String(item.kpi ?? item.metric_key ?? "KPI"), metric_key: item.metric_key ? String(item.metric_key) : null,
      bear_threshold: num(item.bear_threshold), bull_threshold: num(item.bull_threshold) };
    if (!newPeriods.length) return { ...base, status: "not_checkable", value: null, period: null, reason: "No new quarterly statements were captured." };
    let reading = ratioReading(item, book, periodRefs);
    if (!reading && item.metric_key) {
      const series = kpiSeries(item, observations, String(item.metric_key));
      const point = [...series.points].reverse().find(p => p.value !== null && newPeriods.includes(p.period));
      if (point) reading = { value: point.value!, period: point.period };
    }
    if (!reading) return { ...base, status: "not_checkable", value: null, period: null,
      reason: item.metric_key ? `The new filings have no statement line or catalogue metric for ${item.metric_key}.` : "The KPI names no metric key, so code cannot check it." };
    const status = kpiStatus(reading.value, item.bear_threshold, item.bull_threshold);
    if (!status) return { ...base, status: "not_checkable", value: reading.value, period: reading.period, reason: "No danger line is set for this KPI." };
    const line = base.bear_threshold;
    const reason = status === "danger" ? `${reading.period}: ${round(reading.value)} is past the danger line of ${line}.`
      : status === "caution" ? `${reading.period}: ${round(reading.value)} is within 5% of the danger line of ${line}.`
      : `${reading.period}: ${round(reading.value)} is clear of the danger line of ${line}.`;
    return { ...base, status, value: reading.value, period: reading.period, reason };
  });
}
const round = (value: number) => Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(4);

export interface MonitorFiling { form: string; filing_date: string; report_date: string | null; accession: string; url: string; captured: boolean }
export interface RefreshDecision { refresh_due: boolean; reasons: string[] }

/** A refresh is due on a new 10-Q/10-K, a KPI past its danger line, or a passed scheduled refresh date. */
export function refreshDecision(input: { filings: MonitorFiling[]; kpis: MonitorItemResult[]; nextRefreshAt: string | null; now: Date }): RefreshDecision {
  const reasons: string[] = [];
  for (const f of input.filings) reasons.push(`New ${f.form} filed ${f.filing_date}${f.report_date ? ` for the period ending ${f.report_date}` : ""}.`);
  for (const k of input.kpis.filter(k => k.status === "danger")) reasons.push(`${k.kpi} is in danger: ${k.reason}`);
  if (input.nextRefreshAt && Date.parse(input.nextRefreshAt) <= input.now.getTime()) reasons.push(`Scheduled refresh date ${input.nextRefreshAt.slice(0, 10)} has passed.`);
  return { refresh_due: reasons.length > 0, reasons };
}
