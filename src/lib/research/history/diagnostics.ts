/**
 * Historical diagnostics: TTM, growth, incremental margins, and statistics.
 */

import type { HistoricalObservation } from "./contracts";
import { enumerateQuarters, findObservation } from "./normalizer";

export const STOCK_METRICS = new Set([
  "deposits", "deposit_base", "loan_loss_reserve", "loan_portfolio",
  "loans_held_for_investment_net", "loans_held_for_sale", "total_assets",
  "total_liabilities", "stockholders_equity", "employees",
]);

export function buildTTMSeries(
  quarterly: HistoricalObservation[],
  metricKeys: string[],
  startFiscalYear: number,
  startFiscalQuarter: number,
  endFiscalYear: number,
  endFiscalQuarter: number
): HistoricalObservation[] {
  const ttm: HistoricalObservation[] = [];
  const quarters = enumerateQuarters(startFiscalYear, startFiscalQuarter, endFiscalYear, endFiscalQuarter);

  for (const metricKey of metricKeys) {
    // Balance-sheet amounts are point-in-time stocks; summing four snapshots
    // would inflate deposits, loans, assets, liabilities, and reserves.
    if (STOCK_METRICS.has(metricKey) || quarterly.some((observation) =>
      observation.metric_key === metricKey && observation.metadata_json?.metric_category === "balance_sheet"
    )) continue;
    for (let i = 3; i < quarters.length; i++) {
      const q = quarters[i];
      const window = [quarters[i - 3], quarters[i - 2], quarters[i - 1], quarters[i]];
      const values = window
        .map((wq) => findObservation(quarterly, metricKey, wq.fiscal_year, wq.fiscal_quarter))
        .map((o) => o?.value_numeric)
        .filter((v): v is number => v != null);
      if (values.length !== 4) continue;
      const sum = values.reduce((acc, v) => acc + v, 0);
      const latest = findObservation(quarterly, metricKey, q.fiscal_year, q.fiscal_quarter);
      ttm.push({
        metric_key: metricKey,
        fiscal_year: q.fiscal_year,
        fiscal_quarter: q.fiscal_quarter,
        periodicity: "ttm",
        reporting_basis: latest?.reporting_basis ?? "as_reported",
        metric_type: "calculated",
        value_numeric: sum,
        value_text: null,
        unit: latest?.unit ?? null,
        currency: latest?.currency ?? null,
        segment: latest?.segment ?? null,
        geography: latest?.geography ?? null,
        formula_or_adjustment: "sum_of_four_quarters",
        confidence: latest?.confidence ?? 1,
        restatement_version: 0,
        comparability_status: "comparable",
        metadata_json: {},
      });
    }
  }
  return ttm;
}

export function computeGrowthRate(values: number[]): number[] {
  return values.map((v, i) => (i === 0 ? 0 : v / values[i - 1] - 1));
}

export function computeHistoricalStatistics(
  quarterly: HistoricalObservation[],
  ttm: HistoricalObservation[]
): Record<string, Record<string, number>> {
  const stats: Record<string, Record<string, number>> = {};
  const byMetric = groupByMetric(ttm);
  for (const [metricKey, obs] of byMetric.entries()) {
    const values = obs.map((o) => o.value_numeric).filter((v): v is number => v != null);
    if (values.length === 0) continue;
    stats[metricKey] = {
      mean: mean(values),
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
      std_dev: stdDev(values),
      one_year_change: growthOver(values, 4),
      three_year_change: growthOver(values, 12),
    };
  }
  return stats;
}

export function computeIncrementalMargins(
  revenueSeries: HistoricalObservation[],
  profitSeries: HistoricalObservation[]
): { period: string; incremental_margin: number; revenue_growth: number }[] {
  const result: { period: string; incremental_margin: number; revenue_growth: number }[] = [];
  const revs = revenueSeries
    .filter((o) => o.value_numeric != null)
    .sort((a, b) => (a.fiscal_year ?? 0) - (b.fiscal_year ?? 0));
  const profits = profitSeries
    .filter((o) => o.value_numeric != null)
    .sort((a, b) => (a.fiscal_year ?? 0) - (b.fiscal_year ?? 0));
  for (let i = 1; i < revs.length; i++) {
    const revDelta = (revs[i].value_numeric ?? 0) - (revs[i - 1].value_numeric ?? 0);
    const profitDelta = (profits[i]?.value_numeric ?? 0) - (profits[i - 1]?.value_numeric ?? 0);
    if (revDelta === 0) continue;
    result.push({
      period: `${revs[i - 1].fiscal_year}Q${revs[i - 1].fiscal_quarter}-${revs[i].fiscal_year}Q${revs[i].fiscal_quarter}`,
      incremental_margin: profitDelta / revDelta,
      revenue_growth: revDelta / (revs[i - 1].value_numeric ?? 1),
    });
  }
  return result;
}

export function detectInflections(
  series: HistoricalObservation[],
  thresholdSigma = 1.5
): { fiscal_year: number; fiscal_quarter: number | null; value: number; z_score: number }[] {
  const values = series
    .map((o) => ({ y: o.fiscal_year, q: o.fiscal_quarter, v: o.value_numeric }))
    .filter((o): o is { y: number; q: number | null; v: number } => o.v != null && o.y != null);
  if (values.length < 5) return [];
  const mean = values.reduce((s, o) => s + o.v, 0) / values.length;
  const std = stdDev(values.map((o) => o.v));
  if (std === 0) return [];
  return values
    .map((o) => ({ fiscal_year: o.y, fiscal_quarter: o.q, value: o.v, z_score: (o.v - mean) / std }))
    .filter((o) => Math.abs(o.z_score) > thresholdSigma);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(values: number[]): number {
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function growthOver(values: number[], periods: number): number {
  if (values.length <= periods) return 0;
  const recent = values[values.length - 1];
  const past = values[values.length - 1 - periods];
  return past === 0 ? 0 : recent / past - 1;
}

function groupByMetric(observations: HistoricalObservation[]): Map<string, HistoricalObservation[]> {
  const map = new Map<string, HistoricalObservation[]>();
  for (const o of observations) {
    const list = map.get(o.metric_key) ?? [];
    list.push(o);
    map.set(o.metric_key, list);
  }
  return map;
}

export function computeWorkingCapitalMetrics(
  currentAssets: number,
  currentLiabilities: number,
  inventory: number,
  receivables: number,
  payables: number,
  cfo: number,
  revenue: number
): { working_capital: number; cash_conversion: number; receivables_days: number; payables_days: number; inventory_days: number } {
  const working_capital = currentAssets - currentLiabilities;
  const cash_conversion = revenue === 0 ? 0 : working_capital / revenue;
  const receivables_days = revenue === 0 ? 0 : (receivables / revenue) * 365;
  const payables_days = revenue === 0 ? 0 : (payables / revenue) * 365;
  const inventory_days = revenue === 0 ? 0 : (inventory / revenue) * 365;
  return { working_capital, cash_conversion, receivables_days, payables_days, inventory_days };
}

export function perShare(value: number, shares: number): number {
  return shares === 0 ? 0 : value / shares;
}
