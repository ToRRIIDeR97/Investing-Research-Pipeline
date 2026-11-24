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

/** Concepts per field, in priority order. Summed fields list each part. */
const FLOW: Partial<Record<Field, string[]>> = {
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
};
const INSTANT: Partial<Record<Field, string[]>> = {
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  goodwill: ["Goodwill"],
  intangibles: ["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"],
};
/** Total debt: a total concept, else long-term (noncurrent + current) plus short-term borrowings. */
const DEBT_TOTAL = ["LongTermDebt", "DebtLongtermAndShorttermCombinedAmount"];
const DEBT_PARTS = ["LongTermDebtNoncurrent", "LongTermDebtCurrent", "ShortTermBorrowings", "CommercialPaper"];

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
};

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
  const taxonomy: "us-gaap" | "ifrs-full" = facts["us-gaap"] ? "us-gaap" : "ifrs-full";
  const currency = dominantCurrency(facts, taxonomy);
  const cutoff = options.cutoff ?? null;
  const unitFor = (field: Field) => (field === "diluted_shares" ? "shares" : currency);

  // Fiscal year ends: annual revenue or operating-income periods.
  const ends = new Set<string>();
  for (const concept of [...FLOW.revenue!, ...FLOW.ebit!]) {
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
  for (const [field, concepts] of Object.entries(FLOW) as [Field, string[]][]) readers[field] = pick(field, concepts, annualFlows);
  for (const [field, concepts] of Object.entries(INSTANT) as [Field, string[]][]) readers[field] = pick(field, concepts, annualInstants);
  const debtTotal = pick("debt", DEBT_TOTAL, annualInstants);
  const debtParts = DEBT_PARTS.map((c) => ({ c, values: annualInstants(facts, taxonomy, c, currency, cutoff) }));

  const years: AnnualRow[] = periodEnds.map((end) => {
    const values = {} as Record<Field, number | null>;
    const concepts = {} as Record<Field, string | null>;
    for (const field of FIELDS) {
      const reader = readers[field];
      if (reader) [values[field], concepts[field]] = reader(end);
      else { values[field] = null; concepts[field] = null; }
    }
    const [total, totalConcept] = debtTotal(end);
    if (total !== null) { values.debt = total; concepts.debt = totalConcept; }
    else {
      const parts = debtParts.filter((p) => p.values.has(end));
      values.debt = parts.length ? parts.reduce((sum, p) => sum + p.values.get(end)!, 0) : null;
      concepts.debt = parts.length ? parts.map((p) => `${taxonomy}:${p.c}`).join(" + ") : null;
    }
    if (values.equity !== null) {
      values.tangible_book = values.equity - (values.goodwill ?? 0) - (values.intangibles ?? 0);
      concepts.tangible_book = "equity − goodwill − intangibles";
    }
    return { period_end: end, fiscal_year: Number(end.slice(0, 4)) || null, values, concepts };
  });

  for (const field of FIELDS) {
    if (years.length && years.every((y) => y.values[field] === null)) {
      const tried = field === "debt" ? [...DEBT_TOTAL, ...DEBT_PARTS] : field === "tangible_book" ? ["StockholdersEquity"] : (FLOW[field] ?? INSTANT[field] ?? []);
      missing[field] = `No annual ${taxonomy} fact for ${tried.join(", ")}`;
    }
  }

  const sharesRows = unitRows(facts, "dei", "EntityCommonStockSharesOutstanding", "shares")
    .filter((f) => typeof f.val === "number" && !!f.end && (!cutoff || (f.filed ?? f.end) <= cutoff))
    .sort((a, b) => b.end!.localeCompare(a.end!));
  const shares_outstanding = sharesRows[0]
    ? { value: sharesRows[0].val!, as_of: sharesRows[0].end!, concept: "dei:EntityCommonStockSharesOutstanding" }
    : years[0]?.values.diluted_shares
      ? { value: years[0].values.diluted_shares, as_of: years[0].period_end, concept: `${taxonomy}:WeightedAverageNumberOfDilutedSharesOutstanding` }
      : null;

  return { currency, taxonomy, years, missing, shares_outstanding };
}
