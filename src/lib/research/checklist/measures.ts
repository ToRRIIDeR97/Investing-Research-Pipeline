/**
 * Checklist measures: figures code reads from a run's stored artifacts (`financial_analytics`, `report_facts`), in
 * display units. A measure that the run's data cannot give returns a reason instead of a number, never a guess.
 */
type Row = Record<string, any>;
/** A stored artifact as the routes read it; the newest `artifact_version` of each type is used. */
export type ChecklistArtifact = { artifact_type: string; artifact_version?: number | null; content_json: unknown };

export const MEASURE_KEYS = ["revenue_yoy_median", "operating_margin_median", "fcf_margin_median", "roic_median", "net_debt_payback_years",
  "share_change_yoy", "pe_ttm", "tv_share_of_ev"] as const;
export type MeasureKey = typeof MEASURE_KEYS[number];
export type MeasureUnit = "%" | "x" | "years" | "ratio";

export const MEASURES: Record<MeasureKey, { label: string; unit: MeasureUnit; source: string }> = {
  revenue_yoy_median: { label: "Revenue growth, median year over year", unit: "%", source: "financial_analytics.statistics revenue_yoy median" },
  operating_margin_median: { label: "Operating margin, median", unit: "%", source: "financial_analytics.statistics operating_margin median" },
  fcf_margin_median: { label: "Free-cash-flow margin, median", unit: "%", source: "financial_analytics.statistics fcf_margin median" },
  roic_median: { label: "Return on invested capital, median", unit: "%", source: "financial_analytics.statistics roic median" },
  net_debt_payback_years: { label: "Years of free cash flow to repay net debt", unit: "years",
    source: "-net_cash of the latest capital_allocation.quarterly row ÷ the latest cash_conversion.quarterly fcf_ttm (net cash: 0)" },
  share_change_yoy: { label: "Change in share count, year over year", unit: "%", source: "latest capital_allocation.quarterly shares_yoy" },
  pe_ttm: { label: "Price ÷ trailing earnings", unit: "x", source: "report_facts.market.pe_ttm" },
  tv_share_of_ev: { label: "Terminal value share of enterprise value (base case)", unit: "%", source: "report_facts.cases base row tv_share_of_ev" },
};

export type MeasureResult = { value: number; display: string } | { value: null; reason: string };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (n: number, digits: number) => Number(n.toFixed(digits));

/** The newest version of each artifact type. */
function latest(artifacts: ChecklistArtifact[], type: string): Row | null {
  let best: ChecklistArtifact | null = null;
  for (const a of artifacts) if (a.artifact_type === type && (!best || Number(a.artifact_version ?? 0) > Number(best.artifact_version ?? 0))) best = a;
  return best && best.content_json && typeof best.content_json === "object" ? best.content_json as Row : null;
}

/** A columnar table ({ columns, rows }) or an array of objects, as objects. */
function rows(table: unknown): Row[] {
  if (Array.isArray(table)) return table.filter((r) => r && typeof r === "object") as Row[];
  const t = table as { columns?: unknown; rows?: unknown } | null;
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return [];
  const columns = t.columns as string[];
  return (t.rows as unknown[]).filter(Array.isArray).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r as unknown[])[i]])));
}

export function formatMeasure(unit: MeasureUnit, value: number): string {
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (unit === "x") return `${value.toFixed(1)}x`;
  if (unit === "years") return `${value.toFixed(1)} years`;
  return value.toFixed(2);
}
const ok = (key: MeasureKey, value: number): MeasureResult => ({ value, display: formatMeasure(MEASURES[key].unit, value) });
const none = (reason: string): MeasureResult => ({ value: null, reason });

const STATISTIC: Partial<Record<MeasureKey, string>> = { revenue_yoy_median: "revenue_yoy", operating_margin_median: "operating_margin", fcf_margin_median: "fcf_margin", roic_median: "roic" };

/** A measure's value in display units (percent for "%"), or why the run's data cannot give it. */
export function measureValue(key: MeasureKey, artifacts: ChecklistArtifact[]): MeasureResult {
  if (!(key in MEASURES)) return none(`Unknown measure ${String(key)}.`);
  const statistic = STATISTIC[key];
  if (statistic) {
    const analytics = latest(artifacts, "financial_analytics");
    if (!analytics) return none("This run has no financial analytics.");
    const row = rows(analytics.statistics).find((r) => r.metric === statistic);
    if (!row || !finite(row.median)) return none(`The financial history has no median ${statistic.replace(/_/g, " ")}.`);
    return ok(key, round(row.median * 100, 4));
  }
  if (key === "net_debt_payback_years") {
    const analytics = latest(artifacts, "financial_analytics");
    if (!analytics) return none("This run has no financial analytics.");
    const capital = rows(analytics.capital_allocation?.quarterly).at(-1);
    if (!capital || !finite(capital.net_cash)) return none("The latest quarter has no net cash or net debt figure.");
    if (capital.net_cash >= 0) return { value: 0, display: "0.0 years (net cash)" };
    const cash = rows(analytics.cash_conversion?.quarterly).at(-1);
    if (!cash || !finite(cash.fcf_ttm)) return none("The latest quarter has no trailing free cash flow.");
    if (cash.fcf_ttm <= 0) return none("Trailing free cash flow is not positive, so net debt has no payback period.");
    return ok(key, round(-capital.net_cash / cash.fcf_ttm, 4));
  }
  if (key === "share_change_yoy") {
    const analytics = latest(artifacts, "financial_analytics");
    if (!analytics) return none("This run has no financial analytics.");
    const capital = rows(analytics.capital_allocation?.quarterly).at(-1);
    if (!capital || !finite(capital.shares_yoy)) return none("The latest quarter has no year-over-year share change.");
    return ok(key, round(capital.shares_yoy * 100, 4));
  }
  const facts = latest(artifacts, "report_facts");
  if (!facts) return none("This run has no report facts (computed when the report is drafted).");
  if (key === "pe_ttm") {
    const pe = facts.market?.pe_ttm;
    return finite(pe) ? ok(key, pe) : none("Trailing P/E is not available (no positive trailing earnings or market price).");
  }
  const base = rows(facts.cases).find((r) => r.case === "base");
  return base && finite(base.tv_share_of_ev) ? ok(key, round(base.tv_share_of_ev * 100, 4)) : none("The base case has no terminal-value share.");
}
