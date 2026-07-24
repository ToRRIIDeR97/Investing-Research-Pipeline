/**
 * Historical record normalizer: build a twenty-quarter normalized record.
 */

import type { HistoricalObservation, HistoricalCoverageMatrix, HistoricalRecord } from "./contracts";
import { buildTTMSeries } from "./diagnostics";
import { reconcileRecord } from "./reconciliation";
import { computeHistoricalStatistics } from "./diagnostics";

const QUARTERS_REQUIRED = 20;

export type BuildHistoricalRecordInput = {
  asset_id: string;
  run_id?: string;
  observations: HistoricalObservation[];
  requiredMetricKeys: string[];
  endFiscalYear: number;
  endFiscalQuarter: number;
};

export function buildHistoricalRecord(input: BuildHistoricalRecordInput): HistoricalRecord {
  const { asset_id, run_id, observations, requiredMetricKeys, endFiscalYear, endFiscalQuarter } = input;
  const { startFiscalYear, startFiscalQuarter } = computeStartPeriod(endFiscalYear, endFiscalQuarter, QUARTERS_REQUIRED - 1);

  const coverage = buildCoverageMatrix(
    asset_id,
    run_id ?? null,
    observations,
    requiredMetricKeys,
    startFiscalYear,
    startFiscalQuarter,
    endFiscalYear,
    endFiscalQuarter,
    QUARTERS_REQUIRED
  );

  const filtered = observations.filter((obs) => {
    if (obs.periodicity !== "quarterly" || obs.fiscal_year == null || obs.fiscal_quarter == null) return false;
    return isWithinWindow(
      obs.fiscal_year,
      obs.fiscal_quarter,
      startFiscalYear,
      startFiscalQuarter,
      endFiscalYear,
      endFiscalQuarter
    );
  });

  const canonical = takeLatestRestatement(filtered);

  const ttm = buildTTMSeries(
    canonical,
    requiredMetricKeys,
    startFiscalYear,
    startFiscalQuarter,
    endFiscalYear,
    endFiscalQuarter
  );

  const reconciliationIssues = reconcileRecord(canonical, ttm);
  const statistics = computeHistoricalStatistics(canonical, ttm);

  return {
    asset_id,
    run_id: run_id ?? null,
    observations: canonical,
    coverage,
    reconciliation_issues: reconciliationIssues,
    ttm_series: ttm,
    statistics,
  };
}

export function buildCoverageMatrix(
  asset_id: string,
  run_id: string | null,
  observations: HistoricalObservation[],
  requiredMetricKeys: string[],
  startFiscalYear: number,
  startFiscalQuarter: number,
  endFiscalYear: number,
  endFiscalQuarter: number,
  quartersRequired: number
): HistoricalCoverageMatrix {
  const cells: HistoricalCoverageMatrix["cells"] = [];
  let quartersPresent = 0;
  const gaps: HistoricalCoverageMatrix["gaps"] = [];

  const quarters = enumerateQuarters(startFiscalYear, startFiscalQuarter, endFiscalYear, endFiscalQuarter);

  for (const metricKey of requiredMetricKeys) {
    for (const q of quarters) {
      const obs = findObservation(observations, metricKey, q.fiscal_year, q.fiscal_quarter);
      const present = obs != null;
      if (present) quartersPresent++;
      cells.push({
        metric_key: metricKey,
        fiscal_year: q.fiscal_year,
        fiscal_quarter: q.fiscal_quarter,
        present,
        basis: obs?.reporting_basis ?? "as_reported",
        source_document_id: obs?.source_document_id ?? null,
        evidence_claim_id: obs?.evidence_claim_id ?? null,
        why_missing: present ? undefined : `No quarterly observation for ${metricKey} in ${q.fiscal_year}Q${q.fiscal_quarter}`,
      });
      if (!present) {
        gaps.push({
          metric_key: metricKey,
          fiscal_year: q.fiscal_year,
          fiscal_quarter: q.fiscal_quarter,
          why_missing: `Missing quarterly observation for ${metricKey} in ${q.fiscal_year}Q${q.fiscal_quarter}`,
          blocks: "historical_record",
        });
      }
    }
  }

  return {
    asset_id,
    run_id,
    start_fiscal_year: startFiscalYear,
    start_fiscal_quarter: startFiscalQuarter,
    end_fiscal_year: endFiscalYear,
    end_fiscal_quarter: endFiscalQuarter,
    quarters_required: quartersRequired * requiredMetricKeys.length,
    quarters_present: quartersPresent,
    cells,
    gaps,
    is_complete: quartersPresent >= quartersRequired * requiredMetricKeys.length,
  };
}

export function computeStartPeriod(
  endFiscalYear: number,
  endFiscalQuarter: number,
  quartersBack: number
): { startFiscalYear: number; startFiscalQuarter: number } {
  let year = endFiscalYear;
  let quarter = endFiscalQuarter;
  for (let i = 0; i < quartersBack; i++) {
    quarter--;
    if (quarter === 0) {
      quarter = 4;
      year--;
    }
  }
  return { startFiscalYear: year, startFiscalQuarter: quarter };
}

export function isWithinWindow(
    year: number, quarter: number,
    startYear: number, startQuarter: number,
    endYear: number, endQuarter: number
): boolean {
  const start = startYear * 10 + startQuarter;
  const end = endYear * 10 + endQuarter;
  const current = year * 10 + quarter;
  return current >= start && current <= end;
}

export function enumerateQuarters(
  startFiscalYear: number, startFiscalQuarter: number,
  endFiscalYear: number, endFiscalQuarter: number
): { fiscal_year: number; fiscal_quarter: number }[] {
  const quarters: { fiscal_year: number; fiscal_quarter: number }[] = [];
  let year = startFiscalYear;
  let quarter = startFiscalQuarter;
  while (year * 10 + quarter <= endFiscalYear * 10 + endFiscalQuarter) {
    quarters.push({ fiscal_year: year, fiscal_quarter: quarter });
    quarter++;
    if (quarter > 4) {
      quarter = 1;
      year++;
    }
  }
  return quarters;
}

export function findObservation(
  observations: HistoricalObservation[],
  metricKey: string,
  fiscalYear: number,
  fiscalQuarter: number
): HistoricalObservation | null {
  const matches = observations
    .filter(
      (o) =>
        o.metric_key === metricKey &&
        o.fiscal_year === fiscalYear &&
        o.fiscal_quarter === fiscalQuarter &&
        o.periodicity === "quarterly"
    )
    .sort((a, b) => (b.restatement_version ?? 0) - (a.restatement_version ?? 0));
  return matches[0] ?? null;
}

export function takeLatestRestatement(observations: HistoricalObservation[]): HistoricalObservation[] {
  const map = new Map<string, HistoricalObservation>();
  for (const obs of observations) {
    const key = `${obs.metric_key}|${obs.fiscal_year}|${obs.fiscal_quarter}|${obs.periodicity}|${obs.reporting_basis}|${obs.segment ?? ""}|${obs.geography ?? ""}`;
    const existing = map.get(key);
    if (!existing || (obs.restatement_version ?? 0) > (existing.restatement_version ?? 0)) {
      map.set(key, obs);
    }
  }
  return Array.from(map.values());
}

export function buildMELIAdjustedFCFBridge(
  reportedCFO: number,
  customerFundCashMovement: number,
  fintechLoanReceivableMovement: number,
  netFintechFundingFlow: number,
  capex: number,
  intangibles: number
): { adjusted_fcf: number; bridge_items: { label: string; value: number }[] } {
  const bridge_items = [
    { label: "reported_cfo", value: reportedCFO },
    { label: "customer_fund_cash_movement", value: -customerFundCashMovement },
    { label: "fintech_loan_receivable_movement", value: -fintechLoanReceivableMovement },
    { label: "net_fintech_funding_flow", value: -netFintechFundingFlow },
    { label: "capex", value: -capex },
    { label: "intangibles", value: -intangibles },
  ];
  const adjusted_fcf = bridge_items.reduce((sum, item) => sum + item.value, 0);
  return { adjusted_fcf, bridge_items };
}

export function separateMELIRevenueDefinition(
  gaapRevenue: number,
  netRevenuesAndFinancialIncome: number,
  financialIncome: number
): { gaap_revenue: number; financial_income: number; net_revenues_and_financial_income: number } {
  return {
    gaap_revenue: gaapRevenue,
    financial_income: financialIncome,
    net_revenues_and_financial_income: netRevenuesAndFinancialIncome,
  };
}
