/**
 * Historical record normalizer: build a twenty-quarter normalized record.
 */

import type { HistoricalObservation, HistoricalCoverageMatrix, HistoricalRecord } from "./contracts";
import { buildTTMSeries } from "./diagnostics";
import { reconcileRecord } from "./reconciliation";
import { computeHistoricalStatistics } from "./diagnostics";

const QUARTERS_REQUIRED = 20;

export const HIGH_VALUE_KPI_REQUIREMENTS = [
  { metric_key: "members", source_pattern: /\bmembers?\b/i },
  { metric_key: "total_products", source_pattern: /\btotal\s+products?\b|\bproducts?\s+(?:reached|totaled)/i },
  { metric_key: "financial_services_contribution_profit", source_pattern: /financial services[^.]{0,180}contribution (?:profit|loss)/i },
  { metric_key: "financial_services_contribution_margin", source_pattern: /financial services[^.]{0,180}contribution (?:profit )?margin/i },
  { metric_key: "lending_contribution_profit", source_pattern: /lending[^.]{0,180}contribution (?:profit|loss)/i },
  { metric_key: "lending_contribution_margin", source_pattern: /lending[^.]{0,180}contribution (?:profit )?margin/i },
  { metric_key: "technology_platform_contribution_profit", source_pattern: /technology platform[^.]{0,180}contribution (?:profit|loss)/i },
  { metric_key: "technology_platform_contribution_margin", source_pattern: /technology platform[^.]{0,180}contribution (?:profit )?margin/i },
] as const;

export function buildMetricCoverageManifest(
  observations: Record<string, unknown>[],
  sourceTexts: string[],
  requirements: ReadonlyArray<{ metric_key: string; source_pattern: RegExp }> = HIGH_VALUE_KPI_REQUIREMENTS
) {
  return requirements.map((requirement) => {
    const matching = observations.filter((observation) => String(observation.metric_key) === requirement.metric_key);
    const sourceMentions = sourceTexts.filter((text) => requirement.source_pattern.test(text)).length;
    return {
      metric_key: requirement.metric_key,
      observation_count: matching.length,
      source_mentions: sourceMentions,
      status: matching.length > 0 ? "covered" : sourceMentions > 0 ? "present_not_extracted" : "not_found_in_snapshot",
      reason: matching.length > 0
        ? null
        : sourceMentions > 0
          ? "The acquired source corpus mentions this KPI, but no accepted numeric observation was persisted."
          : "No matching disclosure was found in the acquired source snapshot.",
    };
  });
}

const SEC_QUARTERLY_SERIES = [
  { metric_key: "net_revenue", display_name: "Revenue, Net of Interest Expense", metric_category: "income_statement", unit_type: "currency", additive: true, concepts: ["RevenuesNetOfInterestExpense", "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"] },
  { metric_key: "contract_revenue", display_name: "Revenue from Contracts with Customers", metric_category: "income_statement", unit_type: "currency", additive: true, concepts: ["RevenueFromContractWithCustomerExcludingAssessedTax"] },
  { metric_key: "net_interest_income", display_name: "Net Interest Income", metric_category: "income_statement", unit_type: "currency", additive: true, concepts: ["InterestIncomeExpenseNet"] },
  { metric_key: "interest_expense", display_name: "Interest Expense", metric_category: "income_statement", unit_type: "currency", additive: true, concepts: ["InterestExpenseOther", "InterestExpenseOperating", "InterestExpense"] },
  { metric_key: "noninterest_income", display_name: "Noninterest Income", metric_category: "income_statement", unit_type: "currency", additive: true, concepts: ["NoninterestIncome"] },
  { metric_key: "noninterest_expense", display_name: "Noninterest Expense", metric_category: "income_statement", unit_type: "currency", additive: true, concepts: ["NoninterestExpense"] },
  { metric_key: "net_income", display_name: "Net Income", metric_category: "income_statement", unit_type: "currency", additive: true, concepts: ["NetIncomeLoss", "ProfitLoss"] },
  { metric_key: "credit_loss_expense", display_name: "Credit Loss Expense", metric_category: "credit_quality", unit_type: "currency", additive: true, concepts: ["FinancingReceivableExcludingAccruedInterestCreditLossExpenseReversal", "ProvisionForDoubtfulAccounts"] },
  { metric_key: "diluted_eps", display_name: "Diluted Earnings per Share", metric_category: "per_share", unit_type: "per_share", additive: false, concepts: ["EarningsPerShareDiluted"] },
  { metric_key: "diluted_shares", display_name: "Diluted Weighted Average Shares", metric_category: "share_count", unit_type: "shares", additive: false, concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"] },
  { metric_key: "selling_marketing_expense", display_name: "Selling and Marketing Expense", metric_category: "operating_expense", unit_type: "currency", additive: true, concepts: ["SellingAndMarketingExpense"] },
  { metric_key: "research_development_expense", display_name: "Research and Development Expense", metric_category: "operating_expense", unit_type: "currency", additive: true, concepts: ["ResearchAndDevelopmentExpense"] },
] as const;

/** Extract dimensionless, directly reported quarterly series from a stored SEC companyfacts payload. */
export function extractSecQuarterlyObservations(
  companyFacts: Record<string, unknown>,
  sourceDocumentId: string,
  cutoffDate: string
): Record<string, unknown>[] {
  const facts = companyFacts.facts && typeof companyFacts.facts === "object"
    ? companyFacts.facts as Record<string, unknown>
    : {};
  const usGaap = facts["us-gaap"] && typeof facts["us-gaap"] === "object"
    ? facts["us-gaap"] as Record<string, unknown>
    : {};

  return SEC_QUARTERLY_SERIES.flatMap((definition) => {
    const candidates = definition.concepts.map((conceptName) => {
      const concept = usGaap[conceptName] && typeof usGaap[conceptName] === "object"
        ? usGaap[conceptName] as Record<string, unknown>
        : {};
      const units = concept.units && typeof concept.units === "object"
        ? concept.units as Record<string, unknown>
        : {};
      const rows: Record<string, unknown>[] = Object.entries(units).flatMap(([unit, value]) =>
        Array.isArray(value) ? value.map((row) => ({ ...(row as Record<string, unknown>), unit })) : []
      );
      const quarterly = rows.filter((row) => {
        const start = Date.parse(String(row.start || ""));
        const end = Date.parse(String(row.end || ""));
        const days = (end - start) / 86_400_000;
        return Number.isFinite(Number(row.val))
          && Number.isFinite(days) && days >= 70 && days <= 110
          && ["10-Q", "10-K"].includes(String(row.form || ""))
          && String(row.filed || "9999-99-99") <= cutoffDate
          && String(row.end || "9999-99-99") <= cutoffDate;
      });
      return { conceptName, rows: quarterly, allRows: rows };
    }).sort((left, right) => right.rows.length - left.rows.length);

    const selected = candidates[0];
    if (!selected?.rows.length) return [];
    const latestByPeriod = new Map<string, Record<string, unknown>>();
    for (const row of selected.rows) {
      const period = `${row.start}|${row.end}|${row.unit}`;
      const prior = latestByPeriod.get(period);
      if (!prior || String(row.filed || "") > String(prior.filed || "")) latestByPeriod.set(period, row);
    }
    if (definition.additive) {
      const annualRows = selected.allRows.filter((row) => {
        const start = Date.parse(String(row.start || ""));
        const end = Date.parse(String(row.end || ""));
        const days = (end - start) / 86_400_000;
        return Number.isFinite(Number(row.val))
          && Number.isFinite(days) && days >= 300 && days <= 380
          && String(row.form || "") === "10-K"
          && String(row.filed || "9999-99-99") <= cutoffDate
          && String(row.end || "9999-99-99") <= cutoffDate;
      });
      const latestAnnualByEnd = new Map<string, Record<string, unknown>>();
      for (const row of annualRows) {
        const key = `${row.end}|${row.unit}`;
        const prior = latestAnnualByEnd.get(key);
        if (!prior || String(row.filed || "") > String(prior.filed || "")) latestAnnualByEnd.set(key, row);
      }
      for (const annual of latestAnnualByEnd.values()) {
        const annualStart = String(annual.start || "");
        const annualEnd = String(annual.end || "");
        const unit = String(annual.unit || "");
        const directByEnd = new Map<string, Record<string, unknown>>();
        for (const row of latestByPeriod.values()) {
          if (String(row.unit || "") !== unit || String(row.start || "") < annualStart || String(row.end || "") >= annualEnd) continue;
          directByEnd.set(String(row.end), row);
        }
        if (directByEnd.size !== 3 || [...latestByPeriod.values()].some((row) => String(row.unit || "") === unit && String(row.end || "") === annualEnd)) continue;
        const q3End = [...directByEnd.keys()].sort().at(-1)!;
        const q4Start = new Date(`${q3End}T00:00:00Z`);
        q4Start.setUTCDate(q4Start.getUTCDate() + 1);
        const q4Value = Number(annual.val) - [...directByEnd.values()].reduce((sum, row) => sum + Number(row.val), 0);
        const derived = {
          ...annual,
          start: q4Start.toISOString().slice(0, 10),
          val: q4Value,
          derived_from_annual: true,
        };
        latestByPeriod.set(`${derived.start}|${annualEnd}|${unit}`, derived);
      }
    }
    return [...latestByPeriod.values()].map((row) => ({
      metric_key: definition.metric_key,
      display_name: definition.display_name,
      metric_category: definition.metric_category,
      unit_type: definition.unit_type,
      value_numeric: Number(row.val),
      unit: String(row.unit || ""),
      currency: String(row.unit || "").startsWith("USD") ? "USD" : null,
      period_start: String(row.start),
      period_end: String(row.end),
      as_of_date: String(row.end),
      available_at: String(row.filed),
      confidence: 0.98,
      source_id: sourceDocumentId,
      source: "sec_companyfacts",
      reporting_basis: "gaap",
      comparability_status: "comparable",
      metric_type: "reported",
      description: `${definition.display_name} from SEC companyfacts concept ${selected.conceptName}${row.derived_from_annual ? "; Q4 derived as audited annual value minus reported Q1-Q3" : ""}`,
      calculation_method: row.derived_from_annual ? "annual_minus_q1_q2_q3" : "direct_reported_quarter",
      accession_number: row.accn || null,
      fiscal_period: row.fp || null,
      form: row.form || null,
    }));
  });
}

function scaledReportedValue(raw: string, scale: string | undefined) {
  const numeric = Number(raw.replace(/[,$()]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  const multiplier = scale?.toLowerCase().startsWith("b")
    ? 1_000_000_000
    : scale?.toLowerCase().startsWith("m")
      ? 1_000_000
      : scale?.toLowerCase().startsWith("th")
        ? 1_000
        : 1;
  return numeric * multiplier * (raw.includes("(") ? -1 : 1);
}

/** Extract high-value operating KPIs from already verified filing claims. */
export function extractReportedKpiObservations(claims: Record<string, unknown>[]) {
  const observations: Record<string, unknown>[] = [];
  for (const claim of claims) {
    const text = String(claim.claim_text || "").replace(/\s+/g, " ");
    const periodEnd = claim.period_end || claim.as_of_date;
    if (!periodEnd) continue;
    const source = {
      source_id: claim.source_id,
      evidence_claim_id: claim.id,
      period_start: claim.period_start || null,
      period_end: periodEnd,
      as_of_date: periodEnd,
      available_at: claim.available_at || periodEnd,
      confidence: Math.min(0.95, Number(claim.confidence || 0.85)),
      source: "deterministic_verified_claim",
      reporting_basis: "as_reported",
      comparability_status: "comparable",
      metric_type: "reported",
    };
    const countPatterns = [
      { key: "members", label: "Members", regex: /(?:total\s+)?members?(?:\s+(?:reached|totaled|were|was|grew[^.;]{0,30}?to)|\s+to)?\s+(?:approximately\s+|nearly\s+|about\s+)?([\d,.]+)\s*(billion|million|thousand)?/i },
      { key: "total_products", label: "Total products", regex: /(?:total\s+)?products?(?:\s+(?:reached|totaled|were|was|grew[^.;]{0,30}?to)|\s+to)?\s+(?:approximately\s+|nearly\s+|about\s+)?([\d,.]+)\s*(billion|million|thousand)?/i },
    ];
    for (const pattern of countPatterns) {
      const match = pattern.regex.exec(text);
      const value = match ? scaledReportedValue(match[1], match[2]) : null;
      if (value === null || value <= 0) continue;
      observations.push({
        ...source,
        metric_key: pattern.key,
        display_name: pattern.label,
        metric_category: "operating_kpi",
        unit_type: "count",
        value_numeric: value,
        unit: "count",
        currency: null,
        description: `${pattern.label} deterministically parsed from a verified filing claim`,
      });
    }

    const segment = /\b(financial services|lending|technology platform)\b/i.exec(text)?.[1];
    if (!segment) continue;
    const segmentKey = segment.toLowerCase().replace(/\s+/g, "_");
    const margin = /contribution\s+(?:profit\s+)?margin[^.;%\d-]{0,30}(-?[\d,.]+)\s*%/i.exec(text);
    if (margin) {
      observations.push({
        ...source,
        metric_key: `${segmentKey}_contribution_margin`,
        display_name: `${segment} contribution margin`,
        metric_category: "segment_profitability",
        unit_type: "percentage",
        value_numeric: Number(margin[1].replace(/,/g, "")),
        unit: "%",
        currency: null,
        description: `${segment} contribution margin deterministically parsed from a verified filing claim`,
      });
    }
    const profit = /contribution\s+(?:profit|loss)[^.;$\d(+-]{0,30}\$?\s*(\(?-?[\d,.]+\)?)\s*(billion|million|thousand)?/i.exec(text);
    const profitValue = profit ? scaledReportedValue(profit[1], profit[2]) : null;
    if (profitValue !== null) {
      observations.push({
        ...source,
        metric_key: `${segmentKey}_contribution_profit`,
        display_name: `${segment} contribution profit`,
        metric_category: "segment_profitability",
        unit_type: "currency",
        value_numeric: profitValue,
        unit: "USD",
        currency: "USD",
        description: `${segment} contribution profit deterministically parsed from a verified filing claim`,
      });
    }
  }
  return observations;
}

/** Keep the coverage matrix focused on recurring series, while failing visibly when none qualify. */
export function selectHistoricalCoverageMetricKeys(
  observations: HistoricalObservation[],
  minimumDistinctQuarters = 12
): string[] {
  const periodsByMetric = new Map<string, Set<string>>();
  for (const observation of observations) {
    if (observation.periodicity !== "quarterly" || observation.fiscal_year == null || observation.fiscal_quarter == null || observation.value_numeric == null) continue;
    const periods = periodsByMetric.get(observation.metric_key) || new Set<string>();
    periods.add(`${observation.fiscal_year}Q${observation.fiscal_quarter}`);
    periodsByMetric.set(observation.metric_key, periods);
  }
  const recurring = [...periodsByMetric.entries()]
    .filter(([, periods]) => periods.size >= minimumDistinctQuarters)
    .map(([metricKey]) => metricKey)
    .sort();
  return recurring.length ? recurring : [...periodsByMetric.keys()].sort();
}

export function latestCoverageQuarter(
  observations: HistoricalObservation[],
  requiredMetricKeys: string[]
): { fiscal_year: number; fiscal_quarter: number } | null {
  const required = new Set(requiredMetricKeys);
  let latest: { fiscal_year: number; fiscal_quarter: number } | null = null;
  for (const observation of observations) {
    if (observation.periodicity !== "quarterly" || observation.fiscal_year == null
      || observation.fiscal_quarter == null || !required.has(observation.metric_key)) continue;
    const current = observation.fiscal_year * 10 + observation.fiscal_quarter;
    if (!latest || current > latest.fiscal_year * 10 + latest.fiscal_quarter) {
      latest = { fiscal_year: observation.fiscal_year, fiscal_quarter: observation.fiscal_quarter };
    }
  }
  return latest;
}

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

export function isRecurringHistoricalObservation(observation: Record<string, unknown>): boolean {
  const metricKey = String(observation.metric_key || observation.metric || observation.label || "").toLowerCase();
  const value = observation.value_numeric ?? observation.value;
  const hasMeasurementDate = Boolean(observation.period_end || observation.as_of_date);
  return metricKey.length > 0 && value != null && value !== "" && Number.isFinite(Number(value)) && hasMeasurementDate && !isEventLikeHistoricalMetricKey(metricKey);
}

export function isEventLikeHistoricalMetricKey(metricKey: string): boolean {
  return /(^|_)(date|day|month|year|announcement|launch|founded|founding|acquisition|merger|transaction|commitment|funding_round|deadline|duration|spac_merger)(_|$)/.test(metricKey.toLowerCase());
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
      const present = obs?.value_numeric != null;
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
