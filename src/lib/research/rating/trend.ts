/**
 * Technical trend conditions, ported from Pragma's PragTrend (`pragma-web/api/app/services/pragtrend.py`):
 * nine trend-template rules, an RS rating against the S&P 500 and Mansfield relative strength.
 *
 * Differences from Pragma, on purpose:
 * - A rule without enough history is `unavailable` and leaves the denominator, instead of counting as failed.
 * - RS compares with the S&P 500 only; the pipeline stores no sector ETF series.
 * - Mansfield RS uses 52 weekly closes (the usual definition), not 52 daily bars.
 * Inputs are daily closes on one split basis, oldest first.
 */

export type Close = { day: string; close: number };
export type RuleStatus = "pass" | "fail" | "unavailable";
export type TrendRule = { key: string; label: string; status: RuleStatus; reason?: string; detail?: Record<string, number> };
export type TrendResult = {
  rules: TrendRule[];
  passed: number;
  evaluated: number;
  score_label: string;
  rs_rating: number | null;
  mansfield: { value: number; signal: string; weeks: number } | null;
  bars: number;
};

const r2 = (n: number) => Number(n.toFixed(2));

function smaAt(prefix: number[], window: number, end: number): number {
  return (prefix[end + 1] - prefix[end + 1 - window]) / window;
}

/** Pragma's RS rating: weighted 3/6/9/12-month return over the benchmark's, mapped 50 + 140 × difference, 1-99. */
export function rsRating(stock: number[], bench: number[]): number {
  const intervals = [63, 126, 189, 252];
  const weights = [0.4, 0.2, 0.2, 0.2];
  const ret = (s: number[], days: number) => (s.length > days ? s[s.length - 1] / s[s.length - days] - 1 : 0);
  const rel = intervals.reduce((sum, days, i) => sum + weights[i] * (ret(stock, days) - ret(bench, days)), 0);
  const rs = rel >= 0 ? Math.min(99, 50 + rel * 140) : Math.max(1, 50 + rel * 140);
  return Number(rs.toFixed(1));
}

function weekKey(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function weeklyCloses(closes: Close[]): Map<string, number> {
  const weeks = new Map<string, number>();
  for (const bar of closes) weeks.set(weekKey(bar.day), bar.close); // ascending input: the last bar of a week wins
  return weeks;
}

function mansfield(stock: Close[], bench: Close[]): TrendResult["mansfield"] {
  const s = weeklyCloses(stock), b = weeklyCloses(bench);
  const weeks = [...s.keys()].filter((week) => b.has(week)).sort();
  if (weeks.length < 52) return null;
  const ratios = weeks.map((week) => s.get(week)! / b.get(week)!);
  const last52 = ratios.slice(-52);
  const mean = last52.reduce((sum, v) => sum + v, 0) / 52;
  if (!(mean > 0)) return null;
  const value = r2((ratios[ratios.length - 1] / mean - 1) * 100);
  const signal = value > 5 ? "STRONG OUTPERFORMER" : value > 0 ? "OUTPERFORMING" : value > -5 ? "UNDERPERFORMING" : "WEAK";
  return { value, signal, weeks: weeks.length };
}

export function trendRules(stock: Close[], benchmark: Close[] | null): TrendResult {
  const c = stock.map((bar) => bar.close).filter((v) => Number.isFinite(v) && v > 0);
  const n = c.length;
  const prefix = [0];
  for (const v of c) prefix.push(prefix[prefix.length - 1] + v);
  const last = c[n - 1];
  const sma = (window: number, end = n - 1) => smaAt(prefix, window, end);
  const need = (key: string, label: string, bars: number): TrendRule | null =>
    n < bars ? { key, label, status: "unavailable", reason: `Needs ${bars} trading days of prices; ${n} stored.` } : null;
  const rule = (key: string, label: string, pass: boolean, detail: Record<string, number>): TrendRule =>
    ({ key, label, status: pass ? "pass" : "fail", detail });

  const aboveSma = (window: number): TrendRule => {
    const key = `price_above_${window}d_sma`, label = `Price above the ${window}-day average`;
    return need(key, label, window) ?? rule(key, label, last > sma(window), { price: r2(last), sma: r2(sma(window)) });
  };

  const rules: TrendRule[] = [
    aboveSma(150),
    aboveSma(200),
    need("sma_150_above_200", "150-day average above the 200-day", 200)
      ?? rule("sma_150_above_200", "150-day average above the 200-day", sma(150) > sma(200), { sma_150: r2(sma(150)), sma_200: r2(sma(200)) }),
    need("sma_200_trending_up", "200-day average rising for two months", 241)
      ?? rule("sma_200_trending_up", "200-day average rising for two months",
        sma(200) > sma(200, n - 22) && sma(200, n - 21) > sma(200, n - 42),
        { sma_200: r2(sma(200)), sma_200_month_ago: r2(sma(200, n - 22)), sma_200_two_months_ago: r2(sma(200, n - 42)) }),
    need("sma_50_above_150_200", "50-day average above the 150-day and 200-day", 200)
      ?? rule("sma_50_above_150_200", "50-day average above the 150-day and 200-day", sma(50) > sma(150) && sma(50) > sma(200),
        { sma_50: r2(sma(50)), sma_150: r2(sma(150)), sma_200: r2(sma(200)) }),
    aboveSma(50),
  ];

  const lowRule = need("above_52w_low_30pct", "At least 30% above the 52-week low", 252);
  const highRule = need("within_25pct_52w_high", "Within 25% of the 52-week high", 252);
  const year = c.slice(-252);
  const low = Math.min(...year), high = Math.max(...year);
  rules.push(lowRule ?? rule("above_52w_low_30pct", "At least 30% above the 52-week low", (last / low - 1) * 100 >= 30,
    { low_52w: r2(low), pct_above_low: r2((last / low - 1) * 100) }));
  rules.push(highRule ?? rule("within_25pct_52w_high", "Within 25% of the 52-week high", (high / last - 1) * 100 <= 25,
    { high_52w: r2(high), pct_below_high: r2((high / last - 1) * 100) }));

  const benchCloses = (benchmark ?? []).map((bar) => bar.close).filter((v) => Number.isFinite(v) && v > 0);
  let rs: number | null = null;
  if (!benchmark) {
    rules.push({ key: "rs_rating", label: "RS rating above 70 (vs the S&P 500)", status: "unavailable", reason: "No S&P 500 prices are stored." });
  } else if (n < 252 || benchCloses.length < 252) {
    rules.push({ key: "rs_rating", label: "RS rating above 70 (vs the S&P 500)", status: "unavailable",
      reason: `Needs 252 trading days of stock and S&P 500 prices; ${n} and ${benchCloses.length} stored.` });
  } else {
    rs = rsRating(c, benchCloses);
    rules.push(rule("rs_rating", "RS rating above 70 (vs the S&P 500)", rs > 70, { rs_rating: rs, threshold: 70 }));
  }

  const passed = rules.filter((x) => x.status === "pass").length;
  const evaluated = rules.filter((x) => x.status !== "unavailable").length;
  return {
    rules, passed, evaluated,
    score_label: `${passed}/${evaluated} conditions met`,
    rs_rating: rs,
    mansfield: benchmark && n ? mansfield(stock, benchmark) : null,
    bars: n,
  };
}
