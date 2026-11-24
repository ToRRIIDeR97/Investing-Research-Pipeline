/**
 * Weinstein stage analysis, ported from Pragma's `pragtrend.py:compute_stage`: the 30-week (150-day) average, its
 * slope over the last 40 trading days, price against it, and consecutive weeks in the same stage. `stageHistory`
 * (not in Pragma) classifies each of the last 52 weekly closes the same way, for the stage strip.
 */
export type Bar = { day: string; close: number; volume?: number | null };
export type StageName = "STAGE_1_BASE" | "STAGE_2_ADVANCE" | "STAGE_3_TOP" | "STAGE_4_DECLINE" | "UNKNOWN";
export type StageAnalysis = {
  stage: StageName; stage_number: number; label: string; confidence: "HIGH" | "MEDIUM" | "LOW";
  weeks_in_stage: number; sma_30w: number; sma_30w_slope_pct: number; price_vs_sma_30w_pct: number; detail: string;
};

const NUMBER: Record<StageName, number> = { STAGE_1_BASE: 1, STAGE_2_ADVANCE: 2, STAGE_3_TOP: 3, STAGE_4_DECLINE: 4, UNKNOWN: 0 };
const LABELS: Record<StageName, [string, string]> = {
  STAGE_1_BASE: ["Stage 1 — Base", "Building a base after a downtrend. Wait for a Stage 2 breakout."],
  STAGE_2_ADVANCE: ["Stage 2 — Advance", "Established uptrend. The only stage in which to buy."],
  STAGE_3_TOP: ["Stage 3 — Top", "Trend losing steam. Consider trimming, not adding."],
  STAGE_4_DECLINE: ["Stage 4 — Decline", "Active downtrend. Avoid entries here."],
  UNKNOWN: ["Unknown", "Insufficient data for stage classification."],
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export function classify(price: number, sma: number, slope: number): StageName {
  if (!Number.isFinite(sma) || sma === 0) return "UNKNOWN";
  const pct = (price / sma - 1) * 100;
  if (pct < -3 && slope < -1) return "STAGE_4_DECLINE";
  if (pct > 3 && slope > 2) return "STAGE_2_ADVANCE";
  if (pct > 0 && slope > -2 && slope < 2) return "STAGE_3_TOP";
  if (Math.abs(pct) < 5 && Math.abs(slope) < 3) return "STAGE_1_BASE";
  return pct < 0 ? "STAGE_4_DECLINE" : "STAGE_3_TOP";
}

function rollingMean(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(i >= window - 1 ? sum / window : null);
  }
  return out;
}

/** pandas resample("W-FRI").last(): the last close of each Monday–Friday week, keyed by that Friday. */
export function weeklyCloses(bars: Bar[]): { week: string; close: number }[] {
  const byWeek = new Map<string, number>();
  for (const b of bars) {
    const d = new Date(`${b.day}T00:00:00Z`);
    const toFriday = (5 - d.getUTCDay() + 7) % 7;
    d.setUTCDate(d.getUTCDate() + toFriday);
    byWeek.set(d.toISOString().slice(0, 10), b.close);
  }
  return [...byWeek].sort((a, b) => a[0].localeCompare(b[0])).map(([week, close]) => ({ week, close }));
}

export function computeStage(bars: Bar[]): StageAnalysis | null {
  const closes = bars.map((b) => b.close);
  if (closes.length < 200) return null;
  const sma = rollingMean(closes, 150);
  const defined = sma.filter((v): v is number => v !== null);
  if (!defined.length) return null;
  const price = closes[closes.length - 1];
  const smaNow = sma[sma.length - 1];
  if (smaNow === null || smaNow === 0) return null;
  const slopeWindow = defined.slice(-40);
  if (slopeWindow.length < 2) return null;
  const slope = (slopeWindow[slopeWindow.length - 1] / slopeWindow[0] - 1) * 100;
  const stage = classify(price, smaNow, slope);

  const weekly = weeklyCloses(bars).map((w) => w.close);
  const weeklySma = rollingMean(weekly, 30);
  let weeks = 0;
  if (weekly.length > 30) {
    for (let i = weekly.length - 1; i > Math.max(30, weekly.length - 53); i--) {
      const s = weeklySma[i];
      if (s === null) break;
      if (i < 38) break;
      const prior = weeklySma[i - 8];
      if (prior === null) break;
      if (classify(weekly[i], s, (s / prior - 1) * 100) === stage) weeks++;
      else break;
    }
  }
  const confidence = weeks >= 8 && Math.abs(slope) > 3 ? "HIGH" : weeks >= 4 ? "MEDIUM" : "LOW";
  const [label, detail] = LABELS[stage];
  return {
    stage, stage_number: NUMBER[stage], label, confidence, weeks_in_stage: weeks,
    sma_30w: r2(smaNow), sma_30w_slope_pct: r2(slope), price_vs_sma_30w_pct: r2((price / smaNow - 1) * 100), detail,
  };
}

/** The stage of each of the last 52 weeks (weekly close, 30-week average, its 8-week slope), oldest first. */
export function stageHistory(bars: Bar[]): { week: string; stage: StageName; stage_number: number }[] {
  const weekly = weeklyCloses(bars);
  const sma = rollingMean(weekly.map((w) => w.close), 30);
  const out: { week: string; stage: StageName; stage_number: number }[] = [];
  for (let i = Math.max(38, weekly.length - 52); i < weekly.length; i++) {
    const s = sma[i], prior = sma[i - 8];
    if (s === null || prior === null) continue;
    const stage = classify(weekly[i].close, s, (s / prior - 1) * 100);
    out.push({ week: weekly[i].week, stage, stage_number: NUMBER[stage] });
  }
  return out;
}
