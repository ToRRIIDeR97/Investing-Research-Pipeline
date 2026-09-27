/** Quarterly US-GAAP facts from the SEC companyfacts file already stored for a run. */

type SecFact = {
  start?: string;
  end?: string;
  val?: number;
  filed?: string;
  accn?: string;
  form?: string;
};

export function latestSecInstantFact(
  companyFacts: unknown, taxonomy: string, concept: string, unit: string, cutoff: Date
): { value: number; end: string; filed: string; accession_number: string } | null {
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const rows = ((companyFacts as any)?.facts?.[taxonomy]?.[concept]?.units?.[unit] || []) as SecFact[];
  const fact = rows.filter((row) =>
    !row.start && (row.form === "10-K" || row.form === "10-Q") &&
    typeof row.val === "number" && Number.isFinite(row.val) &&
    !!row.end && !!row.filed && !!row.accn &&
    row.end <= cutoffDate && row.filed <= cutoffDate
  ).sort((a, b) => b.end!.localeCompare(a.end!) || b.filed!.localeCompare(a.filed!))[0];
  return fact ? { value: fact.val!, end: fact.end!, filed: fact.filed!, accession_number: fact.accn! } : null;
}

export type SecQuarterlyObservation = {
  metric_key: string;
  display_name: string;
  metric_category: string;
  unit_type: string;
  value_numeric: number;
  unit: string;
  currency: string;
  period_start: string | null;
  period_end: string;
  as_of_date: string;
  available_at: string;
  confidence: number;
  source: string;
  accession_number: string;
  formula_or_adjustment?: string;
};

export const METRICS = [
  { key: "net_revenue", name: "Net Revenue", category: "income_statement", concepts: ["RevenuesNetOfInterestExpense"], instant: false },
  { key: "revenue", name: "Revenue", category: "income_statement", concepts: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], instant: false },
  { key: "net_income", name: "Net Income", category: "income_statement", concepts: ["NetIncomeLoss", "ProfitLoss"], instant: false },
  { key: "net_interest_income", name: "Net Interest Income", category: "income_statement", concepts: ["InterestIncomeExpenseNet"], instant: false },
  { key: "non_interest_income", name: "Noninterest Income", category: "income_statement", concepts: ["NoninterestIncome"], instant: false },
  { key: "credit_losses", name: "Credit Loss Expense", category: "income_statement", concepts: ["FinancingReceivableExcludingAccruedInterestCreditLossExpenseReversal"], instant: false },
  { key: "deposit_interest_expense", name: "Deposit Interest Expense", category: "income_statement", concepts: ["InterestExpenseDeposits"], instant: false },
  { key: "operating_cash_flow", name: "Operating Cash Flow", category: "cash_flow", concepts: ["NetCashProvidedByUsedInOperatingActivities"], instant: false },
  { key: "investing_cash_flow", name: "Investing Cash Flow", category: "cash_flow", concepts: ["NetCashProvidedByUsedInInvestingActivities"], instant: false },
  { key: "financing_cash_flow", name: "Financing Cash Flow", category: "cash_flow", concepts: ["NetCashProvidedByUsedInFinancingActivities"], instant: false },
  { key: "total_assets", name: "Total Assets", category: "balance_sheet", concepts: ["Assets"], instant: true },
  { key: "total_liabilities", name: "Total Liabilities", category: "balance_sheet", concepts: ["Liabilities"], instant: true },
  { key: "stockholders_equity", name: "Stockholders Equity", category: "balance_sheet", concepts: ["StockholdersEquity"], instant: true },
  { key: "deposits", name: "Deposits", category: "balance_sheet", concepts: ["Deposits"], instant: true },
  { key: "loan_loss_reserve", name: "Allowance for Credit Losses on Financing Receivables", category: "balance_sheet", concepts: ["FinancingReceivableAllowanceForCreditLossExcludingAccruedInterest"], instant: true },
  { key: "loans_held_for_investment_net", name: "Loans Held for Investment, Net", category: "balance_sheet", concepts: ["FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss"], instant: true },
  { key: "loans_held_for_sale", name: "Loans Held for Sale", category: "balance_sheet", concepts: ["LoansReceivableHeldForSaleAmount"], instant: true },
] as const;

function quarterOf(date: string): { start: string; end: string; year: number; quarter: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const quarter = Math.ceil(month / 3);
  if (quarter < 1 || quarter > 4) return null;
  const end = new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
  if (date !== end) return null;
  return { year, quarter, start: `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`, end };
}

export function latestSecQuarterlyFact(
  companyFacts: unknown, taxonomy: string, concept: string, unit: string, cutoff: Date
): { value: number; start: string; end: string; filed: string; accession_number: string } | null {
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const rows = ((companyFacts as any)?.facts?.[taxonomy]?.[concept]?.units?.[unit] || []) as SecFact[];
  const fact = rows.filter((row) => {
    const quarter = row.end && quarterOf(row.end);
    return !!quarter && row.start === quarter.start &&
      (row.form === "10-K" || row.form === "10-Q") &&
      typeof row.val === "number" && Number.isFinite(row.val) &&
      !!row.filed && !!row.accn && row.end! <= cutoffDate && row.filed <= cutoffDate;
  }).sort((a, b) => b.end!.localeCompare(a.end!) || b.filed!.localeCompare(a.filed!))[0];
  return fact ? { value: fact.val!, start: fact.start!, end: fact.end!, filed: fact.filed!, accession_number: fact.accn! } : null;
}

function latest(rows: SecFact[]): SecFact | null {
  return rows.sort((a, b) => (b.filed || "").localeCompare(a.filed || "") || (b.accn || "").localeCompare(a.accn || ""))[0] || null;
}

export function secQuarterlyObservations(companyFacts: unknown, cutoff: Date): SecQuarterlyObservation[] {
  const facts = (companyFacts as any)?.facts?.["us-gaap"] || {};
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const observations: SecQuarterlyObservation[] = [];
  for (const metric of METRICS) {
    const isBankContractRevenue = metric.key === "revenue" && !!facts.RevenuesNetOfInterestExpense;
    // A fallback concept is used only when the preferred concept is absent.
    const rows: SecFact[] = metric.concepts.map((concept) => facts[concept]?.units?.USD as SecFact[] | undefined)
      .find((items) => Array.isArray(items) && items.length > 0) || [];
    const valid = rows.filter((row) =>
      (row.form === "10-K" || row.form === "10-Q") &&
      typeof row.val === "number" && Number.isFinite(row.val) &&
      !!row.end && !!row.filed && !!row.accn &&
      row.end <= cutoffDate && row.filed <= cutoffDate && quarterOf(row.end) !== null
    );
    const periods = [...new Set(valid.map((row) => row.end!))].sort().slice(-20);
    for (const end of periods) {
      const quarter = quarterOf(end)!;
      const matching = valid.filter((row) => row.end === end);
      const direct = latest(matching.filter((row) => metric.instant ? !row.start : row.start === quarter.start));
      let fact = direct;
      let value = direct?.val;
      let formula: string | undefined;
      if (!metric.instant && !fact) {
        const ytd = latest(matching.filter((row) => row.start === `${quarter.year}-01-01`));
        const priorEnd = new Date(Date.UTC(quarter.year, (quarter.quarter - 1) * 3, 0)).toISOString().slice(0, 10);
        const priorYtd = quarter.quarter > 1
          ? latest(valid.filter((row) => row.start === `${quarter.year}-01-01` && row.end === priorEnd && row.filed! <= (ytd?.filed || "")))
          : null;
        if (ytd && priorYtd) {
          fact = ytd;
          value = ytd.val! - priorYtd.val!;
          formula = `Quarter = year-to-date ${ytd.accn} less prior year-to-date ${priorYtd.accn}`;
        }
      }
      if (!fact || value === undefined) continue;
      observations.push({
        metric_key: isBankContractRevenue ? "contract_revenue" : metric.key,
        display_name: isBankContractRevenue ? "Revenue from Customer Contracts" : metric.name,
        metric_category: metric.category,
        unit_type: "currency",
        value_numeric: value,
        unit: "USD",
        currency: "USD",
        period_start: metric.instant ? null : quarter.start,
        period_end: end,
        as_of_date: end,
        available_at: `${fact.filed}T00:00:00Z`,
        confidence: formula ? 0.9 : 0.95,
        source: "sec_companyfacts",
        accession_number: fact.accn!,
        ...(formula ? { formula_or_adjustment: formula } : {}),
      });
    }
  }
  return observations;
}
