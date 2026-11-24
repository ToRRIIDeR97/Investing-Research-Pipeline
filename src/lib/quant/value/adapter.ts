/**
 * Quant inputs (SEC fundamentals + stored prices) → Pragma's data shape, using the yfinance row and info names
 * PragValue reads. Y0 is the latest fiscal year (Pragma read trailing-twelve-month `info` values; here the latest
 * annual figure stands in, recorded in the page's notes). Analyst forward EPS and the effective tax rate have no SEC
 * source, so those keys are absent and PragValue falls back exactly as Pragma did without them.
 */
import type { AnnualFundamentals } from "../fundamentals";
import type { QuantBar } from "../inputs";
import type { PragmaData, Statement } from "./model";

export function toPragmaData(f: AnnualFundamentals, bars: QuantBar[], sharesOverride?: number | null): PragmaData {
  const years = f.years;
  const periods = years.map((y) => y.period_end);
  const col = (pick: (v: AnnualFundamentals["years"][number]["values"]) => number | null) => years.map((y) => pick(y.values));
  const st = (rows: Record<string, (number | null)[]>): Statement => ({
    periods,
    rows: Object.fromEntries(Object.entries(rows).filter(([, values]) => values.some((v) => v !== null))),
  });
  const income = st({
    "Total Revenue": col((v) => v.revenue),
    "EBIT": col((v) => v.ebit),
    "Operating Income": col((v) => v.ebit),
    "Net Income": col((v) => v.net_income),
    "Research Development": col((v) => v.rnd),
    "Gross Profit": col((v) => v.gross_profit),
    "Interest Expense": col((v) => v.interest_expense),
    "Depreciation And Amortization": col((v) => v.da),
    "EBITDA": col((v) => (v.ebit !== null && v.da !== null ? v.ebit + v.da : null)),
    "Diluted Average Shares": col((v) => v.diluted_shares),
  });
  const balance = st({
    "Total Debt": col((v) => v.debt),
    "Cash And Cash Equivalents": col((v) => v.cash),
    "Total Stockholders Equity": col((v) => v.equity),
    "Tangible Book Value": col((v) => v.tangible_book),
  });
  const cashflow = st({
    "Operating Cash Flow": col((v) => v.ocf),
    "Capital Expenditure": col((v) => (v.capex === null ? null : -Math.abs(v.capex))),
    "Free Cash Flow": col((v) => (v.ocf !== null && v.capex !== null ? v.ocf - Math.abs(v.capex) : null)),
    "Depreciation And Amortization": col((v) => v.da),
  });

  const y0 = years[0]?.values;
  const price = bars.length ? bars[bars.length - 1].close : null;
  const shares = sharesOverride ?? f.shares_outstanding?.value ?? y0?.diluted_shares ?? null;
  const marketCap = price !== null && shares ? price * shares : null;
  const info: PragmaData["info"] = {
    currentPrice: price,
    sharesOutstanding: shares,
    marketCap,
    totalDebt: y0?.debt ?? null,
    totalCash: y0?.cash ?? null,
    totalRevenue: y0?.revenue ?? null,
    grossProfits: y0?.gross_profit ?? null,
    ebit: y0?.ebit ?? null,
    ebitda: y0 && y0.ebit !== null && y0.da !== null ? y0.ebit + y0.da : null,
    netIncomeToCommon: y0?.net_income ?? null,
    operatingCashflow: y0?.ocf ?? null,
    freeCashflow: y0 && y0.ocf !== null && y0.capex !== null ? y0.ocf - Math.abs(y0.capex) : null,
    returnOnEquity: y0 && y0.net_income !== null && y0.equity ? y0.net_income / y0.equity : null,
    bookValue: y0 && y0.equity !== null && shares ? y0.equity / shares : null,
    dividendYield: y0 && y0.dividends !== null && marketCap ? Math.abs(y0.dividends) / marketCap : null,
  };
  return {
    info, income, income_quarterly: { periods: [], rows: {} }, balance, cashflow,
    history: bars.map((b) => ({ day: b.day, close: b.close })),
  };
}
