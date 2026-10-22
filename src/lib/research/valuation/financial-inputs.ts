/**
 * Compact, typed valuation inputs built from observations the pipeline already captured
 * (financial_statement_set and market_price_history). Request-only: the stored artifacts stay
 * canonical. The layout is fixed (column order, rounding, chronological rows) so identical inputs
 * serialize to identical bytes for prompt caching and task reuse.
 */

type Row = Record<string, any>;

// First captured alias wins for each period, then the first key matching `pattern` (company-prefixed tags such as
// meta_NonmarketableEquitySecuritiesCarryingValue). Sums are used only for split lease balances.
const COLUMNS: { key: string; aliases: string[]; pattern?: RegExp; sum?: string[]; scale: "millions" | "count" }[] = [
  { key: "revenue", aliases: ["revenue", "us_gaap_Revenues", "us_gaap_RevenueFromContractWithCustomerExcludingAssessedTax", "ifrs_full_Revenue"], scale: "millions" },
  { key: "cost_of_revenue", aliases: ["us_gaap_CostOfRevenue", "us_gaap_CostOfGoodsAndServicesSold"], scale: "millions" },
  { key: "operating_income", aliases: ["operating_income", "us_gaap_OperatingIncomeLoss", "ifrs_full_ProfitLossFromOperatingActivities"], scale: "millions" },
  { key: "pretax_income", aliases: ["pretax_income", "us_gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "us_gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"], scale: "millions" },
  { key: "income_tax_expense", aliases: ["income_tax_expense", "us_gaap_IncomeTaxExpenseBenefit"], scale: "millions" },
  { key: "depreciation_amortization", aliases: ["us_gaap_DepreciationDepletionAndAmortization", "us_gaap_DepreciationAmortizationAndAccretionNet", "us_gaap_DepreciationAndAmortization"], scale: "millions" },
  { key: "share_based_compensation", aliases: ["us_gaap_ShareBasedCompensation", "us_gaap_AllocatedShareBasedCompensationExpense"], scale: "millions" },
  { key: "operating_cash_flow", aliases: ["operating_cash_flow", "us_gaap_NetCashProvidedByUsedInOperatingActivities", "ifrs_full_CashFlowsFromUsedInOperatingActivities"], scale: "millions" },
  { key: "capital_expenditures", aliases: ["capex", "us_gaap_PaymentsToAcquirePropertyPlantAndEquipment", "us_gaap_PaymentsToAcquireProductiveAssets"], scale: "millions" },
  { key: "cash_and_equivalents", aliases: ["us_gaap_CashAndCashEquivalentsAtCarryingValue", "ifrs_full_CashAndCashEquivalents"], scale: "millions" },
  { key: "marketable_securities", aliases: ["us_gaap_MarketableSecuritiesCurrent", "us_gaap_ShortTermInvestments", "us_gaap_AvailableForSaleSecuritiesDebtSecuritiesCurrent"], scale: "millions" },
  { key: "long_term_debt", aliases: ["us_gaap_LongTermDebtNoncurrent", "us_gaap_LongTermDebt"], scale: "millions" },
  { key: "current_debt", aliases: ["us_gaap_LongTermDebtCurrent", "us_gaap_DebtCurrent"], scale: "millions" },
  { key: "operating_lease_liabilities", aliases: ["us_gaap_OperatingLeaseLiability"], sum: ["us_gaap_OperatingLeaseLiabilityCurrent", "us_gaap_OperatingLeaseLiabilityNoncurrent"], scale: "millions" },
  // IFRS 16 has one lease liability: no operating/finance split, and lease cost sits below operating income.
  { key: "lease_liabilities_ifrs", aliases: ["ifrs_full_LeaseLiabilities"], sum: ["ifrs_full_CurrentLeaseLiabilities", "ifrs_full_NoncurrentLeaseLiabilities"], scale: "millions" },
  { key: "finance_lease_liabilities", aliases: ["us_gaap_FinanceLeaseLiability"], sum: ["us_gaap_FinanceLeaseLiabilityCurrent", "us_gaap_FinanceLeaseLiabilityNoncurrent"], scale: "millions" },
  // Equity-method and non-marketable stakes: non-operating assets the equity bridge adds.
  { key: "long_term_investments", aliases: ["us_gaap_LongTermInvestments", "us_gaap_EquityMethodInvestments", "us_gaap_EquitySecuritiesWithoutReadilyDeterminableFairValueAmount"],
    pattern: /^[a-z]+_Non[Mm]arketableEquitySecuritiesCarryingValue$/, scale: "millions" },
  { key: "noncontrolling_interest", aliases: ["us_gaap_MinorityInterest"], scale: "millions" },
  { key: "net_ppe", aliases: ["us_gaap_PropertyPlantAndEquipmentNet", "us_gaap_PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization"], scale: "millions" },
  { key: "stockholders_equity", aliases: ["stockholders_equity", "us_gaap_StockholdersEquity"], scale: "millions" },
  { key: "diluted_shares", aliases: ["us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding"], scale: "millions" },
  { key: "employees", aliases: ["employees"], scale: "count" },
];
const MARKET_COLUMNS = ["period_end_close", "market_cap", "price_verified"];

export type ValuationFinancialInputs = {
  currency: string | null;
  /** The taxonomy the captured statements use: us-gaap, or ifrs-full (IFRS 16 leases are debt-like). Optional for stored inputs. */
  accounting_standard?: "us-gaap" | "ifrs-full";
  units: string;
  basis: string[];
  columns: string[];
  quarterly: (string | number | boolean | null)[][];
  annual: (string | number | boolean | null)[][];
  not_captured: string[];
  price_cross_check: { provider: string; verified_periods: number; unverified_periods: number } | null;
};

const round = (value: number, digits: number) => Number(value.toFixed(digits));
const day = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : null);

/** Consolidated, point-in-time rows: no segment or dimension, numeric, public by the cutoff. */
function usable(row: Row, cutoffDay: string) {
  return !row.segment && !row.geography && !row.metadata_json?.dimensions
    && typeof row.value_numeric === "number" && Number.isFinite(row.value_numeric)
    && (day(row.period_end) ?? "9999") <= cutoffDay
    && (!row.available_at || day(row.available_at)! <= cutoffDay);
}

/** The latest restatement known by the cutoff wins when one period has several rows. */
function preferred(a: Row, b: Row) {
  const rank = (row: Row) => [Number(row.restatement_version) || 0, day(row.available_at) || ""] as const;
  const [ra, rb] = [rank(a), rank(b)];
  return ra[0] !== rb[0] ? (ra[0] > rb[0] ? a : b) : ra[1] >= rb[1] ? a : b;
}

function index(rows: Row[], periodicity: string, cutoffDay: string) {
  const byKey = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    if (row.periodicity !== periodicity || !usable(row, cutoffDay)) continue;
    const end = day(row.period_end)!;
    const periods = byKey.get(row.metric_key) ?? new Map<string, Row>();
    const prior = periods.get(end);
    periods.set(end, prior ? preferred(prior, row) : row);
    byKey.set(row.metric_key, periods);
  }
  return byKey;
}

export function valuationFinancialInputs(params: {
  statementObservations: Row[];
  marketObservations?: Row[];
  marketCrossCheck?: Row | null;
  cutoff: Date;
  quarters?: number;
  years?: number;
}): ValuationFinancialInputs | null {
  const cutoffDay = params.cutoff.toISOString().slice(0, 10);
  const revenueCurrency = params.statementObservations.find(
    (row) => row.metric_key === "revenue" && usable(row, cutoffDay) && row.currency
  )?.currency ?? null;
  // Mixed reporting currencies would make the table ambiguous; keep the revenue currency only.
  const statements = params.statementObservations.filter(
    (row) => !revenueCurrency || !row.currency || row.currency === revenueCurrency
  );
  const market = (params.marketObservations ?? []).filter((row) => row.metadata_json?.metric_category === "market_data");

  const table = (periodicity: "quarterly" | "annual", limit: number) => {
    const values = index(statements, periodicity, cutoffDay);
    const keys = [...values.keys()].sort();
    const aliasesOf = (column: (typeof COLUMNS)[number]) => [...column.aliases, ...(column.pattern ? keys.filter((key) => column.pattern!.test(key)) : [])];
    const prices = index(market, periodicity, cutoffDay);
    const ends = new Set<string>();
    for (const column of COLUMNS) {
      for (const key of [...aliasesOf(column), ...(column.sum ?? [])]) for (const end of values.get(key)?.keys() ?? []) ends.add(end);
    }
    const periods = [...ends].sort().slice(-limit);
    return periods.map((end) => {
      const fiscal = COLUMNS.flatMap((c) => c.aliases).map((key) => values.get(key)?.get(end)).find(Boolean);
      const cells = COLUMNS.map((column) => {
        const found = aliasesOf(column).map((key) => values.get(key)?.get(end)).find(Boolean);
        let value: number | null = found ? found.value_numeric : null;
        if (value === null && column.sum) {
          const parts = column.sum.map((key) => values.get(key)?.get(end));
          if (parts.every(Boolean)) value = parts.reduce((total, part) => total + part!.value_numeric, 0);
        }
        if (value === null) return null;
        return column.scale === "millions" ? round(value / 1e6, 1) : Math.round(value);
      });
      const close = prices.get("period_end_share_price")?.get(end);
      const cap = prices.get("market_cap")?.get(end);
      return [
        end,
        fiscal?.fiscal_year ?? Number(end.slice(0, 4)),
        periodicity === "quarterly" ? fiscal?.fiscal_quarter ?? null : null,
        ...cells,
        close ? round(close.value_numeric, 2) : null,
        cap ? round(cap.value_numeric / 1e6, 1) : null,
        close ? close.metadata_json?.verified === true : null,
      ];
    });
  };

  const quarterly = table("quarterly", params.quarters ?? 8);
  const annual = table("annual", params.years ?? 4);
  if (!quarterly.length && !annual.length) return null;
  const allColumns = ["period_end", "fiscal_year", "fiscal_quarter", ...COLUMNS.map((c) => c.key), ...MARKET_COLUMNS];
  // Drop value columns empty in both tables and name them, so absence is explicit.
  const empty = allColumns.map((_, i) => i >= 3 && [...quarterly, ...annual].every((row) => row[i] === null));
  const keep = (row: unknown[]) => row.filter((_, i) => !empty[i]) as (string | number | boolean | null)[];
  const crossCheck = params.marketCrossCheck;
  const ifrs = statements.filter((row) => String(row.metadata_json?.concept ?? "").startsWith("ifrs-full:")).length;
  const gaap = statements.filter((row) => String(row.metadata_json?.concept ?? "").startsWith("us-gaap:")).length;
  return {
    currency: revenueCurrency,
    accounting_standard: ifrs > gaap ? "ifrs-full" : "us-gaap",
    units: `Amounts in ${revenueCurrency ?? "reporting currency"} millions. diluted_shares in millions (weighted-average diluted). employees is a headcount. period_end_close is per share; market_cap in millions.`,
    basis: [
      "Consolidated values only, as filed and public by the cutoff; quarterly flows are standalone quarters (cash-flow quarters derived from cumulative filings).",
      "Balance-sheet columns (cash, securities, investments, debt, leases, noncontrolling interest, net PP&E, equity) are period-end values.",
      "period_end_close is the stored exchange close on or before the period end; price_verified=false means the second provider did not confirm it, not that the close is missing.",
      "Rows are chronological. null means not captured for that period.",
    ],
    columns: keep(allColumns) as string[],
    quarterly: quarterly.map(keep),
    annual: annual.map(keep),
    not_captured: allColumns.filter((_, i) => empty[i]),
    price_cross_check: crossCheck ? {
      provider: String(crossCheck.provider ?? "stooq"),
      verified_periods: Number(crossCheck.verified_periods) || 0,
      unverified_periods: Number(crossCheck.unverified_periods) || 0,
    } : null,
  };
}

/** True when the inputs carry at least one depreciation and amortization value. */
export function hasDepreciationInputs(inputs: ValuationFinancialInputs | null): boolean {
  if (!inputs) return false;
  const at = inputs.columns.indexOf("depreciation_amortization");
  return at >= 0 && [...inputs.quarterly, ...inputs.annual].some((row) => typeof row[at] === "number" && (row[at] as number) > 0);
}
