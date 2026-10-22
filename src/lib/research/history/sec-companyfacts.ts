/** Quarterly US-GAAP facts from the SEC companyfacts file already stored for a run. */

type SecFact = {
  start?: string;
  end?: string;
  val?: number;
  filed?: string;
  accn?: string;
  form?: string;
  frame?: string;
};

export function latestSecInstantFact(
  companyFacts: unknown, taxonomy: string, concept: string, unit: string, cutoff: Date
): { value: number; end: string; filed: string; accession_number: string } | null {
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const rows = ((companyFacts as any)?.facts?.[taxonomy]?.[concept]?.units?.[unit] || []) as SecFact[];
  const fact = rows.filter((row) =>
    !row.start && PERIODIC_FORMS.has(String(row.form)) &&
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

const DAY = 86_400_000;
const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / DAY;
const nextDay = (date: string) => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);

/**
 * A duration fact covers one fiscal quarter when it runs 80-100 days (13- and 14-week quarters
 * included) or SEC framed it as a quarter. Fiscal quarters need not end on calendar quarter-ends.
 */
function isQuarterDuration(row: SecFact): boolean {
  if (!row.start || !row.end) return false;
  if (/^CY\d{4}Q[1-4]$/.test(row.frame || "")) return true;
  const length = days(row.start, row.end);
  return length >= 80 && length <= 100;
}

/** A balance at a fiscal period end: a date some duration fact ends on, a calendar quarter-end, or an instant SEC framed. */
function isQuarterInstant(row: SecFact, periodEnds: Set<string>): boolean {
  if (row.start || !row.end) return false;
  if (/^CY\d{4}Q[1-4]I$/.test(row.frame || "") || periodEnds.has(row.end)) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.end);
  return !!match && Number(match[2]) % 3 === 0 && new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10) === row.end;
}

/**
 * Character span [start, end) of one companyfacts fact object in the stored file text, searched from
 * the concept's key. Facts are flat objects, so the braces around a matching accession number bound it.
 */
export function secFactSpan(
  text: string, concept: string, fact: { value: number; start: string; end: string; accession_number: string }
): { start: number; end: number } | null {
  const from = text.indexOf(`"${concept}":`);
  if (from < 0) return null;
  const needle = JSON.stringify(fact.accession_number);
  for (let at = text.indexOf(needle, from); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    const open = text.lastIndexOf("{", at), close = text.indexOf("}", at);
    if (open < from || close < 0) continue;
    try {
      const row = JSON.parse(text.slice(open, close + 1)) as SecFact;
      if (row.accn === fact.accession_number && row.val === fact.value && row.start === fact.start && row.end === fact.end) {
        return { start: open, end: close + 1 };
      }
    } catch {
      // Not a flat fact object; keep looking.
    }
  }
  return null;
}

export function latestSecQuarterlyFact(
  companyFacts: unknown, taxonomy: string, concept: string, unit: string, cutoff: Date
): { value: number; start: string; end: string; filed: string; accession_number: string } | null {
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const rows = ((companyFacts as any)?.facts?.[taxonomy]?.[concept]?.units?.[unit] || []) as SecFact[];
  const fact = rows.filter((row) => {
    return isQuarterDuration(row) &&
      PERIODIC_FORMS.has(String(row.form)) &&
      typeof row.val === "number" && Number.isFinite(row.val) &&
      !!row.filed && !!row.accn && row.end! <= cutoffDate && row.filed <= cutoffDate;
  }).sort((a, b) => b.end!.localeCompare(a.end!) || b.filed!.localeCompare(a.filed!))[0];
  return fact ? { value: fact.val!, start: fact.start!, end: fact.end!, filed: fact.filed!, accession_number: fact.accn! } : null;
}

function latest(rows: SecFact[]): SecFact | null {
  return rows.sort((a, b) => (b.filed || "").localeCompare(a.filed || "") || (b.accn || "").localeCompare(a.accn || ""))[0] || null;
}

/** Annual and quarterly report forms, domestic and foreign; a foreign issuer's 20-F or 40-F is its annual report. */
const PERIODIC_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F"]);

/** The ISO currency most us-gaap money facts use (CNY for JD), instead of assuming USD; USD when none is present. */
export function dominantCurrency(companyFacts: unknown): string {
  const counts = new Map<string, number>();
  for (const taxonomy of ["us-gaap", "ifrs-full"]) {
    for (const concept of Object.values(((companyFacts as any)?.facts?.[taxonomy] ?? {}) as Record<string, any>)) {
      for (const [unit, rows] of Object.entries(concept?.units ?? {})) if (/^[A-Z]{3}$/.test(unit) && Array.isArray(rows)) counts.set(unit, (counts.get(unit) ?? 0) + rows.length);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
}

/** The reporting taxonomy: "ifrs-full" when IFRS facts outnumber US-GAAP ones (most 20-F filers), else "us-gaap". */
export function reportingTaxonomy(companyFacts: unknown): "us-gaap" | "ifrs-full" {
  const count = (t: string) => Object.keys(((companyFacts as any)?.facts?.[t] ?? {}) as object).length;
  return count("ifrs-full") > count("us-gaap") ? "ifrs-full" : "us-gaap";
}

export function secQuarterlyObservations(companyFacts: unknown, cutoff: Date): SecQuarterlyObservation[] {
  const facts = (companyFacts as any)?.facts?.["us-gaap"] || {};
  const currency = dominantCurrency(companyFacts);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const usable = (row: SecFact) =>
    PERIODIC_FORMS.has(String(row.form)) &&
    typeof row.val === "number" && Number.isFinite(row.val) &&
    !!row.end && !!row.filed && !!row.accn &&
    row.end <= cutoffDate && row.filed <= cutoffDate;
  // Fiscal period ends are where some metric reports a quarter or a year; balances at those dates are quarter-ends.
  const periodEnds = new Set<string>();
  for (const metric of METRICS) {
    if (metric.instant) continue;
    for (const concept of metric.concepts) {
      for (const row of (facts[concept]?.units?.[currency] || []) as SecFact[]) {
        if (row.start && row.end && (isQuarterDuration(row) || (days(row.start, row.end) >= 350 && days(row.start, row.end) <= 380))) periodEnds.add(row.end);
      }
    }
  }
  const observations: SecQuarterlyObservation[] = [];
  for (const metric of METRICS) {
    const isBankContractRevenue = metric.key === "revenue" && !!facts.RevenuesNetOfInterestExpense;
    // A fallback concept is used only when the preferred concept is absent.
    const rows: SecFact[] = metric.concepts.map((concept) => facts[concept]?.units?.[currency] as SecFact[] | undefined)
      .find((items) => Array.isArray(items) && items.length > 0) || [];
    const valid = rows.filter(usable);
    const quarters = new Map<string, { fact: SecFact; value: number; start: string | null; formula?: string }>();
    for (const end of new Set(valid.map((row) => row.end!))) {
      const matching = valid.filter((row) => row.end === end);
      if (metric.instant) {
        const fact = latest(matching.filter((row) => isQuarterInstant(row, periodEnds)));
        if (fact) quarters.set(end, { fact, value: fact.val!, start: null });
        continue;
      }
      const direct = latest(matching.filter(isQuarterDuration));
      if (direct) {
        quarters.set(end, { fact: direct, value: direct.val!, start: direct.start! });
        continue;
      }
      // A quarter not reported on its own is a year-to-date fact less the year-to-date fact with the
      // same start that ends one quarter earlier (a fiscal year need not start on 1 January).
      const ytds = matching.filter((row) => row.start && days(row.start, end) > 100)
        .sort((a, b) => b.filed!.localeCompare(a.filed!) || b.accn!.localeCompare(a.accn!));
      for (const ytd of ytds) {
        const prior = latest(valid.filter((row) => row.start === ytd.start && row.end! < end
          && days(row.end!, end) >= 80 && days(row.end!, end) <= 100 && row.filed! <= ytd.filed!));
        if (!prior) continue;
        quarters.set(end, {
          fact: ytd, value: ytd.val! - prior.val!, start: nextDay(prior.end!),
          formula: `Quarter = year-to-date ${ytd.accn} less prior year-to-date ${prior.accn}`,
        });
        break;
      }
    }
    for (const end of [...quarters.keys()].sort().slice(-20)) {
      const { fact, value, start, formula } = quarters.get(end)!;
      observations.push({
        metric_key: isBankContractRevenue ? "contract_revenue" : metric.key,
        display_name: isBankContractRevenue ? "Revenue from Customer Contracts" : metric.name,
        metric_category: metric.category,
        unit_type: "currency",
        value_numeric: value,
        unit: currency,
        currency,
        period_start: start,
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
