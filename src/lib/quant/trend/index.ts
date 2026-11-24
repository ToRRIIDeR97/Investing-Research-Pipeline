/**
 * PragTrend for the Quant page: the nine conditions and Mansfield RS (src/lib/research/rating/trend.ts), Pragma's
 * combined RS rule (the average of RS against the S&P 500 and the sector ETF, as in `pragtrend._rule_rs_rating`),
 * Weinstein stage and its weekly history, pocket pivots, VCP, and the series the Trend tab charts.
 */
import { rsRating, trendRules, type TrendResult } from "@/lib/research/rating/trend";
import { computeStage, stageHistory, type Bar, type StageAnalysis } from "./stage";
import { detectPocketPivots, detectVcp, type PocketPivots, type Vcp } from "./patterns";
import { rebased } from "./rebased";

export type PragTrend = {
  conditions: TrendResult;
  rs: { vs_spx: number | null; vs_sector: number | null; combined: number | null; sector_symbol: string | null };
  stage: StageAnalysis | null;
  stage_history: ReturnType<typeof stageHistory>;
  pocket_pivots: PocketPivots;
  vcp: Vcp;
  position_52w: { low: number; high: number; price: number; pct_above_low: number; pct_below_high: number } | null;
  charts: {
    price: { day: string; close: number; volume: number | null; sma50: number | null; sma150: number | null; sma200: number | null }[];
    rebased: { stock: { day: string; value: number }[]; spx: { day: string; value: number }[]; sector: { day: string; value: number }[] };
    sparkline: { day: string; close: number }[];
  };
};

function sma(closes: number[], window: number, i: number): number | null {
  if (i + 1 < window) return null;
  let s = 0;
  for (let k = i - window + 1; k <= i; k++) s += closes[k];
  return s / window;
}

export function computePragTrend(bars: Bar[], spx: Bar[], sector: { symbol: string; bars: Bar[] } | null): PragTrend {
  const conditions = trendRules(bars, spx.length ? spx : null);
  const closes = bars.map((b) => b.close);
  const enough = (b: Bar[]) => b.length >= 252;
  const vsSpx = enough(bars) && enough(spx) ? rsRating(closes, spx.map((b) => b.close)) : null;
  const vsSector = sector && enough(bars) && enough(sector.bars) ? rsRating(closes, sector.bars.map((b) => b.close)) : null;
  const combined = vsSpx !== null && vsSector !== null ? Math.round(((vsSpx + vsSector) / 2) * 10) / 10 : vsSpx;
  // Pragma's rule 9: the combined rating above 70 (vs the S&P 500 and the segment benchmark).
  if (combined !== null) {
    const rule = conditions.rules.find((r) => r.key === "rs_rating");
    if (rule) {
      const pass = combined > 70;
      if (rule.status !== "unavailable" && (rule.status === "pass") !== pass) {
        conditions.passed += pass ? 1 : -1;
        conditions.score_label = `${conditions.passed}/${conditions.evaluated} conditions met`;
      }
      rule.status = pass ? "pass" : "fail";
      rule.label = sector ? `RS rating above 70 (vs the S&P 500 and ${sector.symbol})` : rule.label;
      rule.detail = { rs_vs_spx: vsSpx ?? 0, ...(vsSector !== null ? { rs_vs_sector: vsSector } : {}), rs_combined: combined, threshold: 70 };
      conditions.rs_rating = combined;
    }
  }
  const year = closes.slice(-252);
  const price = closes[closes.length - 1];
  const position = year.length >= 2 ? (() => {
    const low = Math.min(...year), high = Math.max(...year);
    return { low, high, price, pct_above_low: Math.round((price / low - 1) * 10000) / 100, pct_below_high: Math.round((1 - price / high) * 10000) / 100 };
  })() : null;
  const start = Math.max(0, bars.length - 252);
  return {
    conditions,
    rs: { vs_spx: vsSpx, vs_sector: vsSector, combined, sector_symbol: sector?.symbol ?? null },
    stage: computeStage(bars),
    stage_history: stageHistory(bars),
    pocket_pivots: detectPocketPivots(bars),
    vcp: detectVcp(bars),
    position_52w: position,
    charts: {
      price: bars.slice(start).map((b, k) => {
        const i = start + k;
        return { day: b.day, close: b.close, volume: b.volume ?? null, sma50: sma(closes, 50, i), sma150: sma(closes, 150, i), sma200: sma(closes, 200, i) };
      }),
      rebased: { stock: rebased(bars), spx: rebased(spx), sector: sector ? rebased(sector.bars) : [] },
      sparkline: bars.slice(-63).map((b) => ({ day: b.day, close: b.close })),
    },
  };
}
