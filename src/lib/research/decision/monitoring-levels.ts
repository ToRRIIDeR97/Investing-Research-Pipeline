/**
 * Current levels for the monitoring dashboard, set by code. A KPI is matched by its metric_key (and segment),
 * never by its name: first against the financial_analytics pack, which also supplies the 20-quarter median and
 * percentile, then against the latest consolidated reported observation with the same key. Values are scaled
 * into the KPI's own unit; a KPI whose unit or sign convention does not fit keeps the model's level.
 */
import { analyticsMetrics, type AnalyticsMetric, type FinancialAnalytics } from "../history/analytics";
import { parseUnit } from "../reporting/dashboard-series";

type Row = Record<string, any>;

const SUFFIX = /_(quarterly|quarter|derived|gaap|reported|as_reported|current|latest|level)$/;
const SYNONYMS: Record<string, string> = {
  revenue_growth: "revenue_yoy", revenue_growth_yoy: "revenue_yoy", revenue_yoy_growth: "revenue_yoy",
  capex_pct_revenue: "capex_to_revenue", capex_intensity: "capex_to_revenue", capex_to_sales: "capex_to_revenue",
  sbc_pct_revenue: "sbc_to_revenue", stock_based_compensation_to_revenue: "sbc_to_revenue",
  free_cash_flow_ttm: "fcf_ttm", ttm_free_cash_flow: "fcf_ttm", free_cash_flow_margin: "fcf_margin",
  days_sales_outstanding: "dso", days_payables_outstanding: "dpo", days_inventory_outstanding: "dio", cash_conversion_cycle: "ccc",
  net_cash_position: "net_cash", shares_outstanding: "shares", period_end_shares: "shares", net_share_count: "shares",
  operating_loss: "operating_income", income_from_operations: "operating_income",
};
const slug = (text: unknown) => String(text ?? "").replace(/^[^:]*:/, "").replace(/Member$/, "")
  .replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const canonical = (key: string) => {
  let k = key.toLowerCase();
  while (SUFFIX.test(k)) k = k.replace(SUFFIX, "");
  return SYNONYMS[k] ?? k;
};

/** The pack metric a KPI names: an exact pack key, or its key with suffixes stripped, synonyms mapped and the segment found. */
export function analyticsMetricFor(item: Row, metrics: Map<string, AnalyticsMetric>): AnalyticsMetric | null {
  const key = String(item.metric_key ?? "");
  if (metrics.has(key)) return metrics.get(key)!;
  const segments = [...new Set([...metrics.keys()].filter((k) => k.startsWith("segment.")).map((k) => k.split(".")[1]))];
  let rest = canonical(key), segment = segments.find((s) => slug(s) === slug(item.segment)) ?? null;
  if (!segment) {
    const named = segments.find((s) => rest.startsWith(`${slug(s)}_`));
    if (named) { segment = named; rest = SYNONYMS[rest.slice(slug(named).length + 1)] ?? rest.slice(slug(named).length + 1); }
  }
  return metrics.get(segment ? `segment.${segment}.${rest}` : rest) ?? null;
}

/** A value in the KPI's unit, or null when the units do not correspond. */
function inUnit(value: number, kind: AnalyticsMetric["kind"] | "reported", from: string | null, unit: unknown, currency: string | null): number | null {
  const to = parseUnit(unit);
  if (!to) return null;
  if (kind === "reported") {
    const source = parseUnit(from);
    return source && source.base === to.base ? value * source.scale / to.scale : null;
  }
  if (kind === "money") return to.currency && to.base === String(currency ?? "").toLowerCase() ? value * 1e6 / to.scale : null;
  if (kind === "shares") return to.base === "share" ? value * 1e6 / to.scale : null;
  if (kind === "days") return /^days?$/.test(to.base) ? value : null;
  if (["%", "percent", "pct"].includes(to.base)) return kind === "ratio" ? value * 100 : null;
  return ["ratio", "decimal", "fraction", "x", "times", "multiple"].includes(to.base) ? value : null;
}

const sameSign = (current: unknown, value: number) => current === null || current === undefined || Number(current) === 0 || value === 0
  || Math.sign(Number(current)) === Math.sign(value);

/** Fill monitoring items in place; returns the metric_keys that code set. */
export function fillMonitoringLevels(items: Row[], inputs: { analytics: FinancialAnalytics | null; latestReported: Row[] }): string[] {
  const metrics = inputs.analytics ? analyticsMetrics(inputs.analytics) : new Map<string, AnalyticsMetric>();
  const reported = new Map(inputs.latestReported.filter((r) => !r.segment && !r.geography && Number.isFinite(Number(r.value_numeric)))
    .map((r) => [String(r.metric_key), r]));
  const filled: string[] = [];
  for (const item of items) {
    const metric = analyticsMetricFor(item, metrics);
    const fromPack = metric ? inUnit(metric.value, metric.kind, null, item.unit, inputs.analytics?.currency ?? null) : null;
    if (metric && fromPack !== null && sameSign(item.current_level, fromPack)) {
      const scale = fromPack / metric.value;
      item.current_level = Number(fromPack.toFixed(6));
      item.history_median = metric.median === null || !Number.isFinite(scale) ? null : Number((metric.median * scale).toFixed(6));
      item.history_percentile = metric.percentile;
      item.source_role = `financial_analytics ${metric.metric} ${metric.period}`;
      filled.push(String(item.metric_key));
      continue;
    }
    const row = reported.get(String(item.metric_key ?? ""));
    const fromRow = row ? inUnit(Number(row.value_numeric), "reported", row.unit, item.unit, null) : null;
    if (row && fromRow !== null && sameSign(item.current_level, fromRow)) {
      item.current_level = Number(fromRow.toFixed(6));
      item.source_role = `Reported ${row.metric_key} ${row.fiscal_year}Q${row.fiscal_quarter}`;
      filled.push(String(item.metric_key));
    } else if (/not provided|requires current update|stale/i.test(String(item.source_role || ""))) {
      item.current_level = null;
    }
  }
  return filled;
}
