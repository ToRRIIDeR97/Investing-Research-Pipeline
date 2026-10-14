/**
 * Sourced cost-of-capital inputs for the valuation: a regression beta computed from stored daily
 * bars against the S&P 500, and a dated implied equity risk premium recorded from its published
 * source. Both are point-in-time: nothing public after the market-data cutoff is used.
 */

import { BETA_BENCHMARK, closeOnSplitBasis, type SplitEvent, type StoredBar } from "@/lib/market-data/price-history";

/** Two years of weekly returns; fewer than a year of them gives no beta. */
export const BETA_WINDOW_WEEKS = 104;
export const BETA_MIN_RETURNS = 52;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const round = (value: number, digits: number) => Number(value.toFixed(digits));
const historyUrl = (symbol: string) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history/`;

/** Monday (UTC) of the week holding a trading day. */
export function weekStart(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  return isoDay(new Date(time - ((new Date(time).getUTCDay() + 6) % 7) * DAY));
}

type WeekPoint = { close: number; verified: boolean };

/** The last close of each week available by the cutoff, on the cutoff day's split basis. */
export function weeklyCloses(bars: StoredBar[], splits: SplitEvent[], cutoffAt: Date): Map<string, WeekPoint> {
  const basis = isoDay(cutoffAt);
  const weeks = new Map<string, WeekPoint & { day: string }>();
  for (const bar of bars) {
    if (Date.parse(bar.available_at) > cutoffAt.getTime() || !(bar.close > 0)) continue;
    const key = weekStart(bar.day);
    const prior = weeks.get(key);
    if (prior && prior.day >= bar.day) continue;
    weeks.set(key, { day: bar.day, close: closeOnSplitBasis(bar.close, bar.day, bar.retrieved_day, basis, splits), verified: bar.verification_status === "verified" });
  }
  return new Map([...weeks].map(([key, point]) => [key, { close: point.close, verified: point.verified }]));
}

export type BetaEstimate = {
  status: "computed" | "unavailable";
  /** The adjusted beta CAPM uses; null when unavailable. */
  value: number | null;
  raw_beta?: number;
  adjusted_beta?: number;
  r_squared?: number;
  standard_error?: number;
  observations?: number;
  window_start?: string;
  window_end?: string;
  reason?: string;
  verified: boolean;
  verification?: { stock_points: number; stock_verified_points: number; benchmark_points: number; benchmark_verified_points: number };
  stock_symbol: string;
  benchmark: { symbol: string; name: string; provider: string };
  market_data_cutoff: string;
  method: string;
  source_urls: string[];
};

type Series = { bars: StoredBar[]; splits: SplitEvent[] };

/**
 * OLS beta of weekly simple price returns (week-last closes, split-adjusted, dividends excluded) on
 * the S&P 500 over the 104 weeks ending in the cutoff week. Only returns between consecutive weeks
 * that both series traded count. The Blume-adjusted beta (0.67 × raw + 0.33) is the value used.
 * It is verified only when every close in the window was cross-checked.
 */
export function regressionBeta(input: { symbol: string; stock: Series; benchmark: Series; cutoffAt: Date }): BetaEstimate {
  const base = {
    stock_symbol: input.symbol.toUpperCase(),
    benchmark: { symbol: BETA_BENCHMARK.symbol, name: BETA_BENCHMARK.name, provider: BETA_BENCHMARK.provider },
    market_data_cutoff: input.cutoffAt.toISOString(),
    method: `OLS slope of weekly simple price returns on the ${BETA_BENCHMARK.name} (${BETA_BENCHMARK.symbol}) over the ${BETA_WINDOW_WEEKS} weeks ending in the cutoff week; week-last closes available by the market-data cutoff, split-adjusted, dividends excluded; adjusted beta = 0.67 × raw + 0.33 (Blume).`,
    source_urls: [historyUrl(input.symbol.toUpperCase()), historyUrl(BETA_BENCHMARK.symbol)],
  };
  const unavailable = (reason: string): BetaEstimate => ({ ...base, status: "unavailable", value: null, verified: false, reason });
  const stock = weeklyCloses(input.stock.bars, input.stock.splits, input.cutoffAt);
  const index = weeklyCloses(input.benchmark.bars, input.benchmark.splits, input.cutoffAt);
  if (!stock.size) return unavailable(`No stored daily prices for ${base.stock_symbol} by the market-data cutoff.`);
  if (!index.size) return unavailable(`No stored ${BETA_BENCHMARK.symbol} benchmark prices by the market-data cutoff.`);
  const firstWeek = isoDay(new Date(Date.parse(weekStart(isoDay(input.cutoffAt))) - BETA_WINDOW_WEEKS * WEEK));
  const weeks = [...stock.keys()].filter((week) => week >= firstWeek && index.has(week)).sort();
  const x: number[] = [], y: number[] = [];
  for (let i = 1; i < weeks.length; i++) {
    if (Date.parse(weeks[i]) - Date.parse(weeks[i - 1]) !== WEEK) continue;
    x.push(index.get(weeks[i])!.close / index.get(weeks[i - 1])!.close - 1);
    y.push(stock.get(weeks[i])!.close / stock.get(weeks[i - 1])!.close - 1);
  }
  if (x.length < BETA_MIN_RETURNS) {
    return unavailable(`Only ${x.length} weekly returns of ${base.stock_symbol} and ${BETA_BENCHMARK.symbol} overlap in the ${BETA_WINDOW_WEEKS} weeks to the cutoff; at least ${BETA_MIN_RETURNS} are needed.`);
  }
  const n = x.length;
  const mx = x.reduce((sum, v) => sum + v, 0) / n, my = y.reduce((sum, v) => sum + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); syy += (y[i] - my) ** 2; }
  if (!(sxx > 0)) return unavailable(`The ${BETA_BENCHMARK.symbol} weekly returns have no variance in the window.`);
  const raw = sxy / sxx;
  const residual = Math.max(0, syy - raw * sxy);
  const verifiedCount = (series: Map<string, WeekPoint>) => weeks.filter((week) => series.get(week)!.verified).length;
  const verification = { stock_points: weeks.length, stock_verified_points: verifiedCount(stock), benchmark_points: weeks.length, benchmark_verified_points: verifiedCount(index) };
  const adjusted = 0.67 * raw + 0.33;
  return {
    ...base, status: "computed", value: round(adjusted, 4), raw_beta: round(raw, 4), adjusted_beta: round(adjusted, 4),
    r_squared: syy > 0 ? round((sxy * sxy) / (sxx * syy), 4) : 0,
    standard_error: n > 2 ? round(Math.sqrt(residual / (n - 2) / sxx), 4) : 0,
    observations: n, window_start: weeks[0], window_end: weeks.at(-1)!,
    verified: verification.stock_verified_points === weeks.length && verification.benchmark_verified_points === weeks.length,
    verification,
  };
}

/**
 * Damodaran's year-end implied ERP for the S&P 500 (FCFE model), recorded from the published table
 * (update of January 2026, read 2026-10-14). A year-end value counts as public from 15 January of
 * the next year, a conservative date for the early-January update.
 */
export const IMPLIED_ERP_SOURCE = {
  publisher: "Aswath Damodaran, NYU Stern",
  series: "Implied ERP (FCFE), S&P 500, year-end",
  url: "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histimpl.html",
  source_update: "January 2026",
  recorded_at: "2026-10-14",
} as const;
export const IMPLIED_ERP_YEAR_END: ReadonlyArray<{ year: number; rate: number }> = [
  { year: 2015, rate: 0.0612 }, { year: 2016, rate: 0.0569 }, { year: 2017, rate: 0.0508 }, { year: 2018, rate: 0.0596 },
  { year: 2019, rate: 0.052 }, { year: 2020, rate: 0.0472 }, { year: 2021, rate: 0.0424 }, { year: 2022, rate: 0.0594 },
  { year: 2023, rate: 0.046 }, { year: 2024, rate: 0.0433 }, { year: 2025, rate: 0.0423 },
];
/** An ERP older than this at the cutoff is still used but flagged as stale. */
const ERP_STALE_DAYS = 400;

export type EquityRiskPremium = {
  rate: number;
  as_of: string;
  available_at: string;
  age_days: number;
  stale: boolean;
  verification_status: "cited_reference";
} & typeof IMPLIED_ERP_SOURCE;

/** The latest recorded implied ERP public by the cutoff; null before the first one. */
export function equityRiskPremiumAt(cutoffAt: Date): EquityRiskPremium | null {
  const cutoffDay = isoDay(cutoffAt);
  const row = [...IMPLIED_ERP_YEAR_END].sort((a, b) => b.year - a.year).find((entry) => `${entry.year + 1}-01-15` <= cutoffDay);
  if (!row) return null;
  const asOf = `${row.year}-12-31`;
  const ageDays = Math.floor((Date.parse(cutoffDay) - Date.parse(asOf)) / DAY);
  return { rate: row.rate, as_of: asOf, available_at: `${row.year + 1}-01-15`, age_days: ageDays, stale: ageDays > ERP_STALE_DAYS,
    verification_status: "cited_reference", ...IMPLIED_ERP_SOURCE };
}

export type CostOfCapitalInputs = {
  beta: BetaEstimate | null;
  equity_risk_premium: EquityRiskPremium | null;
  capm_cost_of_equity: { rate: number; formula: string; verified: boolean; unverified_inputs: string[] } | null;
  gaps: string[];
};

/** Beta, ERP and the CAPM cost of equity they give with the run's risk-free rate, plus a gap per missing or unverified input. */
export function costOfCapitalInputs(input: { beta: BetaEstimate | null; riskFreeRate: { rate: number; observation_date: string } | null; cutoffAt: Date }): CostOfCapitalInputs {
  const erp = equityRiskPremiumAt(input.cutoffAt);
  const beta = input.beta;
  const gaps = [
    ...(beta?.status === "computed" ? [] : [`No regression beta: ${beta?.reason ?? "the market price history carries no beta"}`]),
    ...(beta?.status === "computed" && !beta.verified ? [`Beta ${beta.value} is unverified: ${beta.verification!.stock_points - beta.verification!.stock_verified_points} stock and ${beta.verification!.benchmark_points - beta.verification!.benchmark_verified_points} benchmark weekly closes were not cross-checked.`] : []),
    ...(erp ? [] : ["No implied equity risk premium was public by the cutoff."]),
    ...(erp?.stale ? [`The implied equity risk premium is ${erp.age_days} days old at the cutoff (as of ${erp.as_of}).`] : []),
  ];
  const capm = beta?.status === "computed" && beta.value !== null && erp && input.riskFreeRate ? {
    rate: round(input.riskFreeRate.rate + beta.value * erp.rate, 4),
    formula: `${input.riskFreeRate.rate} risk-free (FRED DGS10, ${input.riskFreeRate.observation_date}) + ${beta.value} adjusted beta × ${erp.rate} implied ERP (${erp.as_of})`,
    verified: beta.verified,
    unverified_inputs: beta.verified ? [] : ["beta"],
  } : null;
  return { beta, equity_risk_premium: erp, capm_cost_of_equity: capm, gaps };
}
