/**
 * Reconciliation engine for historical observations.
 */

import type { HistoricalObservation, ReconciliationIssue } from "./contracts";

import {STOCK_METRICS} from "./diagnostics";
const sameBasis=(a:HistoricalObservation,b:HistoricalObservation)=>a.unit===b.unit&&a.currency===b.currency&&a.reporting_basis===b.reporting_basis&&a.segment===b.segment&&a.geography===b.geography;
const additive=(o:HistoricalObservation)=>!STOCK_METRICS.has(o.metric_key)&&o.metadata_json?.metric_category!=="balance_sheet"&&(!o.unit||/^[A-Z]{3}$/.test(o.unit));

const RELATIVE_TOLERANCE = 0.02;

export function reconcileRecord(
  quarterly: HistoricalObservation[],
  ttm: HistoricalObservation[]
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  issues.push(...reconcileAnnualToQuarters(quarterly));
  issues.push(...reconcileGAAPvsNonGAAP(quarterly));
  issues.push(...reconcileSegmentToConsolidated(quarterly));
  issues.push(...reconcileRestatements(quarterly));
  issues.push(...reconcileTTMToAnnual(ttm, quarterly));
  return issues;
}

export function reconcileAnnualToQuarters(observations: HistoricalObservation[]): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  const annuals = observations.filter((o) => o.periodicity === "annual" && o.value_numeric != null);
  const quarters = observations.filter((o) => o.periodicity === "quarterly" && o.value_numeric != null);
  const byMetric = groupBy(annuals, (o) => o.metric_key);

  for (const [metricKey, annualObs] of byMetric.entries()) {
    for (const annual of annualObs) {
      if (annual.fiscal_year == null || !additive(annual)) continue;
      const matchingQuarters = quarters.filter(
        (q) => q.metric_key === metricKey && q.fiscal_year === annual.fiscal_year && sameBasis(q,annual)
      );
      if (matchingQuarters.length !== 4 || new Set(matchingQuarters.map(q=>q.fiscal_quarter)).size !== 4) continue;
      const sum = matchingQuarters.reduce((acc, q) => acc + (q.value_numeric ?? 0), 0);
      const annualValue = annual.value_numeric ?? 0;
      if (annualValue === 0) continue;
      const relDiff = Math.abs(sum - annualValue) / Math.abs(annualValue);
      if (relDiff > RELATIVE_TOLERANCE) {
        issues.push({
          issue_type: "annual_quarterly_mismatch",
          severity: "blocking",
          description: `Annual ${metricKey} for FY${annual.fiscal_year} (${annualValue}) does not reconcile to sum of quarters (${sum}).`,
          metric_key: metricKey,
          fiscal_year: annual.fiscal_year,
          left_value: annualValue,
          right_value: sum,
          left_basis: "annual",
          right_basis: "sum_of_quarters",
        });
      }
    }
  }
  return issues;
}

export function reconcileGAAPvsNonGAAP(observations: HistoricalObservation[]): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  const byKeyPeriod = groupBy(
    observations.filter((o) => o.value_numeric != null),
    (o) => `${o.metric_key}|${o.periodicity}|${o.fiscal_year}|${o.fiscal_quarter}|${o.unit}|${o.currency}`
  );
  for (const [key, obs] of byKeyPeriod.entries()) {
    const gaap = obs.find((o) => o.reporting_basis === "gaap");
    const nonGaap = obs.find((o) => o.reporting_basis === "non_gaap" || o.reporting_basis === "adjusted");
    if (gaap && nonGaap && gaap.value_numeric && nonGaap.value_numeric) {
      if (Math.abs((gaap.value_numeric - nonGaap.value_numeric) / gaap.value_numeric) > RELATIVE_TOLERANCE) {
        issues.push({
          issue_type: "gaap_non_gaap_conflict",
          severity: "warning",
          description: `GAAP and adjusted values for ${key} differ materially.`,
          metric_key: gaap.metric_key,
          fiscal_year: gaap.fiscal_year ?? undefined,
          left_value: gaap.value_numeric,
          right_value: nonGaap.value_numeric,
          left_basis: "gaap",
          right_basis: "adjusted",
        });
      }
    }
  }
  return issues;
}

export function reconcileSegmentToConsolidated(observations: HistoricalObservation[]): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  const consolidated = observations.filter((o) => !o.segment && o.value_numeric != null);
  const segments = observations.filter((o) => o.segment && o.value_numeric != null);

  const byMetricYear = groupBy(consolidated, (o) => `${o.metric_key}|${o.periodicity}|${o.fiscal_year}|${o.fiscal_quarter}|${o.unit}|${o.currency}`);
  for (const [key, consObs] of byMetricYear.entries()) {
    const cons = consObs[0];
    const segmentSum = segments
      .filter((s) => `${s.metric_key}|${s.periodicity}|${s.fiscal_year}|${s.fiscal_quarter}|${s.unit}|${s.currency}` === key && s.reporting_basis === cons.reporting_basis && s.geography === cons.geography && !s.metadata_json?.dimensions)
      .reduce((acc, s) => acc + (s.value_numeric ?? 0), 0);
    if (segmentSum === 0 || !cons.value_numeric) continue;
    if (Math.abs(segmentSum - cons.value_numeric) / Math.abs(cons.value_numeric) > RELATIVE_TOLERANCE) {
      issues.push({
        issue_type: "segment_consolidated_mismatch",
        severity: "blocking",
        description: `Segment totals for ${key} (${segmentSum}) do not reconcile to consolidated (${cons.value_numeric}).`,
        metric_key: cons.metric_key,
        fiscal_year: cons.fiscal_year ?? undefined,
        left_value: cons.value_numeric,
        right_value: segmentSum,
        left_basis: "consolidated",
        right_basis: "sum_of_segments",
      });
    }
  }
  return issues;
}

export function reconcileRestatements(observations: HistoricalObservation[]): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  const restated = observations.filter((o) => (o.restatement_version ?? 0) > 0 && o.value_numeric != null);
  for (const o of restated) {
    issues.push({
      issue_type: "restatement",
      severity: "info",
      description: `Metric ${o.metric_key} for ${o.fiscal_year}Q${o.fiscal_quarter} has restatement version ${o.restatement_version}.`,
      metric_key: o.metric_key,
      fiscal_year: o.fiscal_year ?? undefined,
      left_value: o.value_numeric ?? undefined,
      right_value: o.value_numeric ?? undefined,
      left_basis: "restatement",
      right_basis: "original",
    });
  }
  return issues;
}

export function reconcileTTMToAnnual(
  ttm: HistoricalObservation[],
  quarterly: HistoricalObservation[]
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  const annuals = quarterly.filter((o) => o.periodicity === "annual" && o.value_numeric != null);
  for (const annual of annuals) {
    if (annual.fiscal_year == null || !additive(annual)) continue;
    const ttmObs = ttm.find(
      (t) => t.metric_key === annual.metric_key && t.fiscal_year === annual.fiscal_year && t.fiscal_quarter === 4 && sameBasis(t,annual)
    );
    if (ttmObs && ttmObs.value_numeric && annual.value_numeric) {
      if (Math.abs(ttmObs.value_numeric - annual.value_numeric) / Math.abs(annual.value_numeric) > RELATIVE_TOLERANCE) {
        issues.push({
          issue_type: "annual_quarterly_mismatch",
          severity: "warning",
          description: `TTM ${annual.metric_key} for FY${annual.fiscal_year} (${ttmObs.value_numeric}) differs from annual (${annual.value_numeric}).`,
          metric_key: annual.metric_key,
          fiscal_year: annual.fiscal_year,
          left_value: annual.value_numeric,
          right_value: ttmObs.value_numeric,
          left_basis: "annual",
          right_basis: "ttm",
        });
      }
    }
  }
  return issues;
}

export function checkLookahead(
  observation: HistoricalObservation,
  cutoffDate: string
): ReconciliationIssue | null {
  if (!observation.available_at) return null;
  if (observation.available_at <= cutoffDate) return null;
  return {
    issue_type: "point_in_time_lookahead",
    severity: "blocking",
    description: `Observation for ${observation.metric_key} available at ${observation.available_at} is after cutoff ${cutoffDate}.`,
    metric_key: observation.metric_key,
    fiscal_year: observation.fiscal_year ?? undefined,
  };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}
