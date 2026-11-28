/**
 * Annual fundamentals for listings that don't file with SEC (BBCA.JK, VOD.L, 7203.T), from Yahoo Finance's public
 * fundamentals-timeseries endpoint, in the same shape `annualFundamentals` builds from companyfacts. Yahoo's output is
 * untrusted: every value is type-checked and the response is size-capped. Cash-flow outflows Yahoo reports as negative
 * (capex, dividends) are stored positive, as SEC reports them.
 */
import { readCapped } from "@/lib/net";
import { FIELDS, type AnnualFundamentals, type AnnualRow, type Field } from "./fundamentals";

const TIMESERIES_URL = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";
const HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const MAX_BYTES = 4_000_000;
const TIMEOUT_MS = 12_000;

/** Yahoo series per field, in priority order. */
const SERIES: Record<Field, string[]> = {
  revenue: ["TotalRevenue", "OperatingRevenue"],
  gross_profit: ["GrossProfit"],
  ebit: ["OperatingIncome", "EBIT"],
  net_income: ["NetIncomeCommonStockholders", "NetIncome"],
  da: ["ReconciledDepreciation", "DepreciationAndAmortization", "DepreciationAmortizationDepletion"],
  rnd: ["ResearchAndDevelopment"],
  interest_expense: ["InterestExpense", "InterestExpenseNonOperating"],
  ocf: ["OperatingCashFlow", "CashFlowFromContinuingOperatingActivities"],
  capex: ["CapitalExpenditure", "PurchaseOfPPE"],
  dividends: ["CashDividendsPaid", "CommonStockDividendPaid"],
  cash: ["CashAndCashEquivalents", "CashCashEquivalentsAndShortTermInvestments", "CashAndDueFromBanks"],
  debt: ["TotalDebt"],
  equity: ["StockholdersEquity", "CommonStockEquity"],
  goodwill: ["Goodwill"],
  intangibles: ["OtherIntangibleAssets"],
  tangible_book: [],
  diluted_shares: ["DilutedAverageShares", "BasicAverageShares"],
};
const POSITIVE: Field[] = ["capex", "dividends"];
const EXTRA = ["OrdinarySharesNumber", "ShareIssued"];

/** Every series type the endpoint is asked for. */
export function yahooFundamentalTypes(): string[] {
  const names = new Set<string>();
  for (const list of Object.values(SERIES)) for (const n of list) names.add(n);
  const annual = [...names, ...EXTRA].map((n) => `annual${n}`);
  return [...annual, "quarterlyTotalRevenue", "quarterlyOperatingIncome"];
}

type Point = { date: string; value: number; currency: string | null };

/** Series name (with its annual/quarterly prefix) → dated values. Pure; tolerates malformed bodies. */
function readSeries(body: unknown): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  const result = (body as { timeseries?: { result?: unknown } })?.timeseries?.result;
  if (!Array.isArray(result)) return out;
  for (const entry of result) {
    if (!entry || typeof entry !== "object") continue;
    const type = (entry as { meta?: { type?: unknown } }).meta?.type;
    const name = Array.isArray(type) && typeof type[0] === "string" ? type[0] : null;
    if (!name) continue;
    const rows = (entry as Record<string, unknown>)[name];
    if (!Array.isArray(rows)) continue;
    const points: Point[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as { asOfDate?: unknown; currencyCode?: unknown; reportedValue?: { raw?: unknown } };
      const value = r.reportedValue?.raw;
      if (typeof r.asOfDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.asOfDate) || typeof value !== "number" || !Number.isFinite(value)) continue;
      points.push({ date: r.asOfDate, value, currency: typeof r.currencyCode === "string" && /^[A-Z]{3}$/.test(r.currencyCode) ? r.currencyCode : null });
    }
    if (points.length) out.set(name, points);
  }
  return out;
}

/** Yahoo's timeseries as annual fundamentals (newest five years first), or null when no year has revenue. Pure. */
export function parseYahooFundamentals(body: unknown, options: { years?: number } = {}): AnnualFundamentals | null {
  const series = readSeries(body);
  const at = (name: string) => new Map((series.get(name) ?? []).map((p) => [p.date, p]));
  const revenueDates = new Set<string>();
  for (const n of SERIES.revenue) for (const d of at(`annual${n}`).keys()) revenueDates.add(d);
  const ends = [...revenueDates].sort().reverse().slice(0, options.years ?? 5);
  if (!ends.length) return null;

  const currencies = new Map<string, number>();
  for (const [name, points] of series) if (name.startsWith("annual")) for (const p of points) if (p.currency) currencies.set(p.currency, (currencies.get(p.currency) ?? 0) + 1);
  const currency = [...currencies].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";

  const years: AnnualRow[] = ends.map((end) => {
    const values = {} as Record<Field, number | null>;
    const concepts = {} as Record<Field, string | null>;
    for (const field of FIELDS) {
      values[field] = null; concepts[field] = null;
      for (const n of SERIES[field]) {
        const p = at(`annual${n}`).get(end);
        if (p) { values[field] = POSITIVE.includes(field) ? Math.abs(p.value) : p.value; concepts[field] = `yahoo:${n}`; break; }
      }
    }
    if (values.equity !== null) {
      values.tangible_book = values.equity - (values.goodwill ?? 0) - (values.intangibles ?? 0);
      concepts.tangible_book = "equity − goodwill − intangibles";
    }
    return { period_end: end, fiscal_year: Number(end.slice(0, 4)) || null, values, concepts };
  });

  const missing: AnnualFundamentals["missing"] = {};
  for (const field of FIELDS) {
    if (years.every((y) => y.values[field] === null)) missing[field] = `Yahoo Finance has no annual ${SERIES[field].join(" or ") || "equity"} series`;
  }

  let shares: AnnualFundamentals["shares_outstanding"] = null;
  for (const n of EXTRA) {
    const latest = [...(series.get(`annual${n}`) ?? [])].sort((a, b) => b.date.localeCompare(a.date))[0];
    if (latest && latest.value > 0) { shares = { value: latest.value, as_of: latest.date, concept: `yahoo:${n}` }; break; }
  }
  if (!shares && years[0].values.diluted_shares) shares = { value: years[0].values.diluted_shares, as_of: years[0].period_end, concept: years[0].concepts.diluted_shares ?? "yahoo:DilutedAverageShares" };

  const qRev = at("quarterlyTotalRevenue"), qEbit = at("quarterlyOperatingIncome");
  const quarters = [...qRev.keys()].filter((d) => qEbit.has(d)).sort().reverse().slice(0, 4)
    .map((d) => ({ period_end: d, revenue: qRev.get(d)!.value, ebit: qEbit.get(d)!.value }));

  // `taxonomy` names the statement vocabulary; Yahoo restates filings in its own (IFRS-like) line items.
  return { currency, taxonomy: "ifrs-full", years, missing, shares_outstanding: shares, quarters };
}

/** Fetches and parses Yahoo fundamentals for a symbol. Throws when Yahoo can't be reached. */
export async function fetchYahooFundamentals(symbol: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<AnnualFundamentals | null> {
  const params = new URLSearchParams({
    type: yahooFundamentalTypes().join(","),
    period1: String(Math.floor(now.getTime() / 1000) - 7 * 366 * 86_400),
    period2: String(Math.floor(now.getTime() / 1000) + 86_400),
  });
  const response = await fetchImpl(`${TIMESERIES_URL}/${encodeURIComponent(symbol)}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!response.ok) throw new Error(`Yahoo fundamentals returned ${response.status}`);
  return parseYahooFundamentals(JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_BYTES))));
}
