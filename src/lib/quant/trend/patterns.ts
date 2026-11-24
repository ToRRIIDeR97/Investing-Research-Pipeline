/**
 * Pocket pivots and the Volatility Contraction Pattern, ported from Pragma's `pattern_detector.py`
 * (`detect_pocket_pivot`, `_find_swing_points`, `detect_vcp`). Both need daily volume; without it the result is
 * `unavailable` rather than a guess.
 */
import type { Bar } from "./stage";
import { pyRound } from "../value/model";

export type PocketPivot = { day: string; close: number; volume: number; max_down_volume_10d: number; volume_ratio: number };
export type PocketPivots =
  | { status: "computed"; is_today: boolean; days_since_last: number | null; events: PocketPivot[] }
  | { status: "unavailable"; reason: string; events: [] };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function detectPocketPivots(bars: Bar[], lookbackDays = 90): PocketPivots {
  if (bars.length < 12) return { status: "unavailable", reason: "Needs at least 12 trading days.", events: [] };
  const n = bars.length;
  // Only the bars the scan reads (the lookback plus the 10-day down-volume window before it) need volume.
  const first = Math.max(11, n - lookbackDays) - 11;
  if (bars.slice(first).some((b) => b.volume === null || b.volume === undefined)) {
    return { status: "unavailable", reason: "Daily volume is not stored for the scanned window.", events: [] };
  }
  const events: PocketPivot[] = [];
  for (let i = Math.max(11, n - lookbackDays); i < n; i++) {
    if (bars[i].close <= bars[i - 1].close) continue;
    let maxDown = 0;
    for (let j = i - 10; j < i; j++) if (bars[j].close < bars[j - 1].close) maxDown = Math.max(maxDown, Math.trunc(bars[j].volume!));
    if (maxDown <= 0) continue;
    const vol = Math.trunc(bars[i].volume!);
    if (vol > maxDown) events.push({ day: bars[i].day, close: r2(bars[i].close), volume: vol, max_down_volume_10d: maxDown, volume_ratio: r2(vol / maxDown) });
  }
  if (!events.length) return { status: "computed", is_today: false, days_since_last: null, events: [] };
  const last = events[events.length - 1];
  const latest = bars[n - 1].day;
  return {
    status: "computed", is_today: last.day === latest,
    days_since_last: Math.round((Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${last.day}T00:00:00Z`)) / 86_400_000),
    events: events.slice(-10),
  };
}

export type VcpContraction = { high_day: string; high_price: number; low_day: string; low_price: number; depth_pct: number; duration_days: number; avg_volume_during: number };
export type Vcp = {
  status: "computed" | "unavailable"; is_vcp: boolean; quality: "TIGHT" | "FORMING" | "NOT_PRESENT";
  contractions: VcpContraction[]; base_length_weeks: number; base_high: number | null; base_low: number | null;
  above_30w_sma: boolean; detail: string;
};

function swingPoints(closes: number[], window = 5): [number[], number[]] {
  const peaks: number[] = [], troughs: number[] = [];
  for (let i = window; i < closes.length - window; i++) {
    const chunk = closes.slice(i - window, i + window + 1);
    const c = closes[i];
    if (c === Math.max(...chunk) && c > closes[i - 1]) peaks.push(i);
    else if (c === Math.min(...chunk) && c < closes[i - 1]) troughs.push(i);
  }
  return [peaks, troughs];
}

export function detectVcp(bars: Bar[], lookbackWeeks = 26): Vcp {
  const empty = (detail: string, above = false, contractions: VcpContraction[] = []): Vcp =>
    ({ status: bars.length ? "computed" : "unavailable", is_vcp: false, quality: "NOT_PRESENT", contractions, base_length_weeks: 0, base_high: null, base_low: null, above_30w_sma: above, detail });
  if (!bars.length) return empty("Insufficient data for VCP detection.");
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume ?? 0);
  const n = closes.length;
  const lookback = Math.min(n, lookbackWeeks * 5);
  if (lookback < 30) return empty("Need at least 30 bars for VCP detection.");
  if (bars.slice(-lookback).some((b) => b.volume === null || b.volume === undefined)) {
    return { ...empty("Daily volume is not stored for the VCP window."), status: "unavailable" };
  }
  const wc = closes.slice(-lookback), wv = volumes.slice(-lookback), wd = bars.slice(-lookback).map((b) => b.day);
  const sma150 = n >= 150 ? closes.slice(-150).reduce((s, v) => s + v, 0) / 150 : NaN;
  const above = Number.isFinite(sma150) ? closes[n - 1] > sma150 : false;
  const [peaks, troughs] = swingPoints(wc, 5);
  if (peaks.length < 2 || troughs.length < 2) return empty("Not enough swing points in the lookback window.", above);
  let contractions: VcpContraction[] = [];
  for (const p of peaks) {
    const t = troughs.find((x) => x > p);
    if (t === undefined) continue;
    const hi = wc[p], lo = wc[t];
    if (hi <= lo) continue;
    const depth = (1 - lo / hi) * 100;
    if (depth < 1) continue;
    const vols = wv.slice(p, t + 1);
    contractions.push({ high_day: wd[p], high_price: r2(hi), low_day: wd[t], low_price: r2(lo), depth_pct: r2(depth), duration_days: t - p,
      avg_volume_during: t > p ? pyRound(vols.reduce((s, v) => s + v, 0) / vols.length) : 0 });
  }
  if (contractions.length < 2) return empty("Fewer than 2 contractions detected.", above, contractions);
  contractions = contractions.slice(-4);
  const depthsDecreasing = contractions.every((c, i) => i === 0 || c.depth_pct < contractions[i - 1].depth_pct);
  const volDecreasing = contractions.every((c, i) => i === 0 || !(c.avg_volume_during > contractions[i - 1].avg_volume_during * 1.1));
  const baseHigh = Math.max(...contractions.map((c) => c.high_price)), baseLow = Math.min(...contractions.map((c) => c.low_price));
  const baseWeeks = Math.max(1, Math.floor((Date.parse(`${bars[n - 1].day}T00:00:00Z`) - Date.parse(`${contractions[0].high_day}T00:00:00Z`)) / 86_400_000 / 7));
  const isVcp = depthsDecreasing && above;
  let quality: Vcp["quality"], detail: string;
  if (isVcp && volDecreasing && contractions[contractions.length - 1].depth_pct < 8) {
    quality = "TIGHT"; detail = `Tight VCP — ${contractions.length} contractions, latest pullback only ${contractions[contractions.length - 1].depth_pct.toFixed(1)}%.`;
  } else if (isVcp) {
    quality = "FORMING"; detail = `VCP forming — ${contractions.length} contractions, depths ${contractions.map((c) => `${c.depth_pct.toFixed(1)}%`).join(", ")}.`;
  } else {
    quality = "NOT_PRESENT";
    detail = !above ? "Base is not above the 30-week SMA — Stage 2 prerequisite fails." : !depthsDecreasing ? "Contractions are not progressively shallower — not a VCP." : "Pattern does not meet VCP criteria.";
  }
  return { status: "computed", is_vcp: isVcp, quality, contractions, base_length_weeks: baseWeeks, base_high: r2(baseHigh), base_low: r2(baseLow), above_30w_sma: above, detail };
}
