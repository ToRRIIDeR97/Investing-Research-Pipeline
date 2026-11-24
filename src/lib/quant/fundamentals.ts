/**
 * Annual fundamentals for the Quant page, read from SEC companyfacts (or the XBRL warehouse's rebuild of it).
 *
 * PragValue was written against yfinance statements. This maps each field it reads to SEC/XBRL concepts, in
 * priority order. Flows are fiscal-year facts (330-400 day durations from annual forms); balances are instants at
 * those fiscal-year ends. The latest filing wins for a period. A field with no fact is null with a reason, never 0.
 */
type Row = Record<string, any>;
type Fact = { start?: string; end?: string; val?: number; accn?: string; fy?: number; fp?: string; form?: string; filed?: string };

export const FIELDS = [
  "revenue", "gross_profit", "ebit", "net_income", "da", "rnd", "interest_expense", "ocf", "capex", "dividends",
  "cash", "debt", "equity", "goodwill", "intangibles", "tangible_book", "diluted_shares",
] as const;
export type Field = typeof FIELDS[number];

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A", "10-KT"]);
const DAY = 86_400_000;

/**
 * Concepts per field and taxonomy, in priority order. Debt: a combined total, else long-term debt (total, or
 * noncurrent + current) plus short-term borrowings and commercial paper. Cash adds current marketable securities.
 */
type ConceptMap = {
  flow: Partial<Record<Field, string[]>>;
  instant: Partial<Record<Field, string[]>>;
  /** Totals that already include short-term borrowings. */
  debtCombined: string[];
  /** A long-term total (current portion included), else its parts. */
  debtLongTerm: string[];
  debtLongTermParts: string[];
  debtShortTerm: string[];
  cashAdds: string[];
};
const CONCEPTS: Record<"us-gaap" | "ifrs-full", ConceptMap> = {
  "us-gaap": {
    flow: {
      revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense"],
      gross_profit: ["GrossProfit"],
      ebit: ["OperatingIncomeLoss"],
      net_income: ["NetIncomeLoss", "ProfitLoss"],
      da: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet", "Depreciation"],
      rnd: ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"],
      interest_expense: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
      ocf: ["NetCashProvidedByUsedInOperatingActivities"],
      capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
      dividends: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
      diluted_shares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    },
    instant: {
      cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"],
      equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
      goodwill: ["Goodwill"],
      intangibles: ["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"],
    },
    debtCombined: ["DebtLongtermAndShorttermCombinedAmount"],
    debtLongTerm: ["LongTermDebt"],
    debtLongTermParts: ["LongTermDebtNoncurrent", "LongTermDebtCurrent"],
    debtShortTerm: ["ShortTermBorrowings", "CommercialPaper"],
    cashAdds: ["MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "ShortTermInvestments"],
  },
  "ifrs-full": {
    flow: {
      revenue: ["Revenue", "RevenueFromContractsWithCustomers"],
      gross_profit: ["GrossProfit"],
      ebit: ["ProfitLossFromOperatingActivities"],
      net_income: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"],
      da: ["DepreciationAndAmortisationExpense", "DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss"],
      rnd: ["ResearchAndDevelopmentExpense"],
      interest_expense: ["FinanceCosts", "InterestExpense"],
      ocf: ["CashFlowsFromUsedInOperatingActivities"],
      capex: ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "PurchaseOfPropertyPlantAndEquipment"],
      dividends: ["DividendsPaidClassifiedAsFinancingActivities", "DividendsPaid"],
      diluted_shares: ["AdjustedWeightedAverageShares", "WeightedAverageShares"],
    },
    instant: {
      cash: ["CashAndCashEquivalents"],
      equity: ["EquityAttributableToOwnersOfParent", "Equity"],
      goodwill: ["Goodwill"],
      intangibles: ["IntangibleAssetsOtherThanGoodwill"],
    },
    debtCombined: ["Borrowings"],
    debtLongTerm: ["LongtermBorrowings"],
    debtLongTermParts: ["NoncurrentPortionOfNoncurrentBorrowings", "CurrentPortionOfLongtermBorrowings"],
    debtShortTerm: ["ShorttermBorrowings"],
    cashAdds: ["CurrentInvestments"],
  },
};

export type AnnualRow = {
  period_end: string;
  fiscal_year: number | null;
  values: Record<Field, number | null>;
  concepts: Record<Field, string | null>;
};
export type AnnualFundamentals = {
  currency: string;
  taxonomy: "us-gaap" | "ifrs-full";
  years: AnnualRow[];
  missing: Partial<Record<Field, string>>;
  shares_outstanding: { value: number; as_of: string; concept: string } | null;
  /** The latest four fiscal quarters with both revenue and operating income, newest first (Q4 = year − Q1..Q3). */
  quarters: { period_end: string; revenue: number; ebit: number }[];
};

/** Discrete quarters (80–100 day facts, latest filing wins) plus Q4 derived from the year less its three quarters. */
function quarterly(facts: Row, taxonomy: string, concepts: string[], unit: string, cutoff: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const concept of concepts) {
    const best = new Map<string, Fact>();
    const rows = unitRows(facts, taxonomy, concept, unit).filter((f) => typeof f.val === "number" && Number.isFinite(f.val)
      && !!f.start && !!f.end && !!f.filed && (!cutoff || (f.filed <= cutoff && f.end <= cutoff)));
    for (const f of rows) {
      const span = days(f.start!, f.end!);
      if (span < 80 || span > 100) continue;
      const prior = best.get(f.end!);
      if (!prior || f.filed! > prior.filed!) best.set(f.end!, f);
    }
    for (const year of annualFlows(facts, taxonomy, concept, unit, cutoff)) {
      const [end, total] = year;
      if (best.has(end)) continue;
      const yearStart = Date.parse(`${end}T00:00:00Z`) - 400 * DAY;
      const inside = [...best.values()].filter((q) => Date.parse(`${q.end}T00:00:00Z`) < Date.parse(`${end}T00:00:00Z`)
        && Date.parse(`${q.start}T00:00:00Z`) > yearStart && days(q.end!, end) <= 300);
      if (inside.length === 3) best.set(end, { end, start: inside[inside.length - 1].end, val: total - inside.reduce((s, q) => s + q.val!, 0), filed: "", accn: "" });
    }
    for (const [end, f] of best) if (!out.has(end)) out.set(end, f.val!);
    if (out.size >= 4) break;
  }
  return out;
}

const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY;

function unitRows(facts: Row, taxonomy: string, concept: string, unit: string): Fact[] {
  return ((facts?.[taxonomy]?.[concept]?.units?.[unit]) || []) as Fact[];
}

function usable(f: Fact, cutoff: string | null): boolean {
  return ANNUAL_FORMS.has(String(f.form)) && typeof f.val === "number" && Number.isFinite(f.val) && !!f.end && !!f.filed
    && (!cutoff || (f.filed <= cutoff && f.end <= cutoff));
}

/** Latest-filed annual duration value per period end. */
function annualFlows(facts: Row, taxonomy: string, concept: string, unit: string, cutoff: string | null): Map<string, number> {
  const best = new Map<string, Fact>();
  for (const f of unitRows(facts, taxonomy, concept, unit)) {
    if (!usable(f, cutoff) || !f.start) continue;
    const span = days(f.start, f.end!);
    if (span < 330 || span > 400) continue;
    const prior = best.get(f.end!);
    if (!prior || f.filed! > prior.filed!) best.set(f.end!, f);
  }
  return new Map([...best].map(([end, f]) => [end, f.val!]));
}

/** Latest-filed annual-form instant value per date. */
function annualInstants(facts: Row, taxonomy: string, concept: string, unit: string, cutoff: string | null): Map<string, number> {
  const best = new Map<string, Fact>();
  for (const f of unitRows(facts, taxonomy, concept, unit)) {
    if (!usable(f, cutoff) || f.start) continue;
    const prior = best.get(f.end!);
    if (!prior || f.filed! > prior.filed!) best.set(f.end!, f);
  }
  return new Map([...best].map(([end, f]) => [end, f.val!]));
}

function dominantCurrency(facts: Row, taxonomy: string): string {
  const counts = new Map<string, number>();
  for (const concept of ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "OperatingIncomeLoss", "NetIncomeLoss", "Revenue", "ProfitLoss"]) {
    for (const unit of Object.keys(facts?.[taxonomy]?.[concept]?.units ?? {})) {
      if (/^[A-Z]{3}$/.test(unit)) counts.set(unit, (counts.get(unit) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
}

export function annualFundamentals(companyFacts: unknown, options: { years?: number; cutoff?: string | null } = {}): AnnualFundamentals {
  const facts = (companyFacts as Row)?.facts ?? {};
  // IFRS filers (20-F, 40-F) report in ifrs-full; a filer with both is read as us-gaap.
  const taxonomy: "us-gaap" | "ifrs-full" = facts["us-gaap"] ? "us-gaap" : "ifrs-full";
  const C = CONCEPTS[taxonomy];
  const currency = dominantCurrency(facts, taxonomy);
  const cutoff = options.cutoff ?? null;
  const unitFor = (field: Field) => (field === "diluted_shares" ? "shares" : currency);

  // Fiscal year ends: annual revenue or operating-income periods.
  const ends = new Set<string>();
  for (const concept of [...C.flow.revenue!, ...C.flow.ebit!]) {
    for (const end of annualFlows(facts, taxonomy, concept, currency, cutoff).keys()) ends.add(end);
  }
  const periodEnds = [...ends].sort().reverse().slice(0, options.years ?? 5);

  const missing: Partial<Record<Field, string>> = {};
  const pick = (field: Field, concepts: string[], read: typeof annualFlows) => {
    const series = concepts.map((c) => ({ concept: c, values: read(facts, taxonomy, c, unitFor(field), cutoff) }));
    return (end: string): [number | null, string | null] => {
      const hit = series.find((s) => s.values.has(end));
      return hit ? [hit.values.get(end)!, `${taxonomy}:${hit.concept}`] : [null, null];
    };
  };
  const readers: Partial<Record<Field, (end: string) => [number | null, string | null]>> = {};
  for (const [field, concepts] of Object.entries(C.flow) as [Field, string[]][]) readers[field] = pick(field, concepts, annualFlows);
  for (const [field, concepts] of Object.entries(C.instant) as [Field, string[]][]) readers[field] = pick(field, concepts, annualInstants);
  const instants = (list: string[]) => list.map((c) => ({ c, values: annualInstants(facts, taxonomy, c, currency, cutoff) }));
  const combined = pick("debt", C.debtCombined, annualInstants);
  const longTotal = pick("debt", C.debtLongTerm, annualInstants);
  const longParts = instants(C.debtLongTermParts), shortParts = instants(C.debtShortTerm);
  const cashAdd = pick("cash", C.cashAdds, annualInstants);
  const sumAt = (parts: { c: string; values: Map<string, number> }[], end: string) => {
    const hit = parts.filter((p) => p.values.has(end));
    return hit.length ? { value: hit.reduce((s, p) => s + p.values.get(end)!, 0), concept: hit.map((p) => `${taxonomy}:${p.c}`).join(" + ") } : null;
  };

  const years: AnnualRow[] = periodEnds.map((end) => {
    const values = {} as Record<Field, number | null>;
    const concepts = {} as Record<Field, string | null>;
    for (const field of FIELDS) {
      const reader = readers[field];
      if (reader) [values[field], concepts[field]] = reader(end);
      else { values[field] = null; concepts[field] = null; }
    }
    const [all, allConcept] = combined(end);
    if (all !== null) { values.debt = all; concepts.debt = allConcept; }
    else {
      const [lt, ltConcept] = longTotal(end);
      const long = lt !== null ? { value: lt, concept: ltConcept! } : sumAt(longParts, end);
      const short = sumAt(shortParts, end);
      values.debt = long || short ? (long?.value ?? 0) + (short?.value ?? 0) : null;
      concepts.debt = long || short ? [long?.concept, short?.concept].filter(Boolean).join(" + ") : null;
    }
    const [extraCash, extraConcept] = cashAdd(end);
    if (values.cash !== null && extraCash !== null) { values.cash += extraCash; concepts.cash = `${concepts.cash} + ${extraConcept}`; }
    if (values.equity !== null) {
      values.tangible_book = values.equity - (values.goodwill ?? 0) - (values.intangibles ?? 0);
      concepts.tangible_book = "equity − goodwill − intangibles";
    }
    return { period_end: end, fiscal_year: Number(end.slice(0, 4)) || null, values, concepts };
  });

  for (const field of FIELDS) {
    if (years.length && years.every((y) => y.values[field] === null)) {
      const tried = field === "debt" ? [...C.debtCombined, ...C.debtLongTerm, ...C.debtLongTermParts, ...C.debtShortTerm]
        : field === "tangible_book" ? (C.instant.equity ?? []) : (C.flow[field] ?? C.instant[field] ?? []);
      missing[field] = `No annual ${taxonomy} fact for ${tried.join(", ")}`;
    }
  }

  // Shares outstanding: dei lists one fact per share class with no dimension (GOOGL, BRK), so the classes reported
  // on the latest date in the latest filing are summed.
  const sharesRows = unitRows(facts, "dei", "EntityCommonStockSharesOutstanding", "shares")
    .filter((f) => typeof f.val === "number" && !!f.end && (!cutoff || (f.filed ?? f.end) <= cutoff));
  const latestEnd = sharesRows.reduce((m, f) => (f.end! > m ? f.end! : m), "");
  const onLatest = sharesRows.filter((f) => f.end === latestEnd);
  const latestFiled = onLatest.reduce((m, f) => ((f.filed ?? "") > m ? f.filed ?? "" : m), "");
  const classes = onLatest.filter((f) => (f.filed ?? "") === latestFiled);
  const shareSum = classes.reduce((s, f) => s + f.val!, 0);
  const shares_outstanding = classes.length
    ? { value: shareSum, as_of: latestEnd, concept: `dei:EntityCommonStockSharesOutstanding${classes.length > 1 ? ` (${classes.length} classes summed)` : ""}` }
    : years[0]?.values.diluted_shares
      ? { value: years[0].values.diluted_shares, as_of: years[0].period_end, concept: years[0].concepts.diluted_shares ?? `${taxonomy}:diluted shares` }
      : null;

  const qRevenue = quarterly(facts, taxonomy, C.flow.revenue!, currency, cutoff);
  const qEbit = quarterly(facts, taxonomy, C.flow.ebit!, currency, cutoff);
  const quarters = [...qRevenue.keys()].filter((end) => qEbit.has(end)).sort().reverse().slice(0, 4)
    .map((end) => ({ period_end: end, revenue: qRevenue.get(end)!, ebit: qEbit.get(end)! }));

  return { currency, taxonomy, years, missing, shares_outstanding, quarters };
}
