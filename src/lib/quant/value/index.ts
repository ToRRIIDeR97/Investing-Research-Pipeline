/**
 * PragValue entry point, ported from pulsevalue.py `compute_pulse_value`: route → engine → confidence → Credit
 * Impact Scalar → multi-metric DCF → PulseScore → deviation grades. Plus the series the Quant page charts.
 */
import { gradeForDeviation, gradeLabel } from "@/lib/research/rating/grade";
import { computeDcf, clamp, historicalMultiples, primaryMetricFor, projectWithReversion, pyRound, safeFloat,
  DEVIATION_BAND_CUTOFFS, type DcfResult, type Engine, type EngineResult, type PragmaData } from "./model";
import { routeEngine, runEngine } from "./engines";

export type PragValue = {
  engine: Engine;
  sector: string;
  industry: string;
  engine_result: EngineResult;
  confidence: number;
  cis: { status: "computed" | "unavailable"; credit_z: number | null; adjuster: number; applied: boolean; reason?: string };
  dcf: DcfResult;
  pulse_score: number;
  mos_z: number | null;
  targets: { bear: number; base: number; bull: number };
  current_price: number;
  v_deviation: string;
  pq_deviation: string;
  adjusted_deviation: number;
  pulse_grade: { grade: string; label: string };
  pq_grade: { grade: string; label: string };
  /** Chart series (not in Pragma's output). */
  charts: {
    projection: { year: number; bear: number; base: number; bull: number }[];
    value_build: { pv_cash_flows: number; pv_terminal: number; net_debt_per_share: number; per_share: number; metric: string; terminal_share: number } | null;
    multiple_history: { metric: string; points: { period: string; multiple: number }[]; current: number | null; percentile: number | null; p25: number | null; p75: number | null };
  };
  notes: string[];
};

/** Pragma's band lookup (same cutoffs as rating/grade.ts). */
function band(dev: number): string {
  for (const [g, cut] of DEVIATION_BAND_CUTOFFS) if (dev < cut) return g;
  return "F";
}

function confidenceScore(data: PragmaData, er: EngineResult): number {
  let base = { High: 85, Medium: 65, Low: 40 }[er.data_quality] ?? 65;
  const years = Math.max(data.income.periods.length, data.balance.periods.length, data.cashflow.periods.length);
  if (years >= 5) base += 8; else if (years >= 3) base += 3;
  base -= Math.min(er.structural_flags.length * 3, 10);
  return Math.trunc(clamp(base, 0, 100));
}

function scenarioFallback(score: number, price: number, cisAdj: number, history: PragmaData["history"]): [number, number, number] {
  const basePct = score * 0.125;
  let std = 0.15;
  if (history.length > 50) {
    const returns: number[] = [];
    for (let i = 1; i < history.length; i++) returns.push(history[i].close / history[i - 1].close - 1);
    if (returns.length > 20) {
      const m = returns.reduce((s, r) => s + r, 0) / returns.length;
      const sd = Math.sqrt(returns.reduce((s, r) => s + (r - m) ** 2, 0) / (returns.length - 1));
      std = clamp(sd * Math.sqrt(252), 0.1, 0.5);
    }
  }
  return [pyRound(price * (1 + basePct - std * cisAdj), 2), pyRound(price * (1 + basePct), 2), pyRound(price * (1 + basePct + std * cisAdj), 2)];
}

function pqBand(adjDev: number, price: number, bear: number, bull: number, cisZ: number): string {
  const bearRet = price > 0 ? bear / price - 1 : 0, bullRet = price > 0 ? bull / price - 1 : 0;
  const asym = bearRet !== 0 ? clamp(bullRet / Math.abs(bearRet), 0, 5) : 1;
  const asymScore = asym >= 1 ? -Math.min((asym - 1) * 0.2, 0.3) : Math.min((1 - asym) * 0.3, 0.3);
  return band(adjDev * 0.55 + asymScore * 0.25 + -clamp(cisZ, -2, 2) * 0.1 * 0.2);
}

export function computePragValue(data: PragmaData, meta: { sector: string; industry: string; companyName?: string | null; creditZ?: number | null }): PragValue {
  const { info } = data;
  const notes: string[] = [];
  let price = safeFloat(info, "currentPrice", "regularMarketPrice") || 0;
  if (price === 0 && data.history.length) price = data.history[data.history.length - 1].close;
  let ebitTtm = safeFloat(info, "ebit") || null;
  if (ebitTtm === null) { const v = data.income.rows["EBIT"]?.[0]; if (typeof v === "number" && Number.isFinite(v)) ebitTtm = v; }
  const revenueTtm = safeFloat(info, "totalRevenue") || null;
  const engine = routeEngine(meta.sector, meta.industry, ebitTtm, revenueTtm, meta.companyName ?? null);
  const er = runEngine(engine, data, meta.sector, meta.industry);
  const confidence = confidenceScore(data, er);

  const creditZ = meta.creditZ ?? null;
  const cisZ = creditZ ?? 0;
  let cisAdj = clamp(1 / (1 + 0.06 * cisZ), 0.7, 1.2);
  const cisApplied = engine !== "C" && engine !== "B2";
  if (!cisApplied) cisAdj = 1;
  if (creditZ === null) notes.push("Credit Impact Scalar unavailable: no credit-spread series is collected, so the discount rate is not adjusted (1.0).");

  const dcf = computeDcf(engine, data, er, meta.industry, meta.sector, cisAdj);
  let pulse: number, mosZ: number | null = null, bear: number, base: number, bull: number;
  if (!dcf.dcf_skipped && dcf.mos_base !== 0) {
    mosZ = clamp(dcf.mos_base / 0.25, -3, 3);
    pulse = clamp(mosZ, -3, 3);
    bear = dcf.intrinsic_value_bear; base = dcf.intrinsic_value_base; bull = dcf.intrinsic_value_bull;
  } else {
    const fallback = er.fallback_score ?? 0;
    pulse = cisApplied ? clamp(fallback * cisAdj, -3, 3) : clamp(fallback, -3, 3);
    [bear, base, bull] = scenarioFallback(pulse, price, cisAdj, data.history);
  }
  const adjDev = base === 0 || price === 0 ? 0 : (price / base - 1) * Math.sqrt(confidence / 100);
  const vDev = band(adjDev), pqDev = pqBand(adjDev, price, bear, bull, cisZ);
  if (vDev !== gradeForDeviation(adjDev)) notes.push("Band tables disagree"); // guard: both use Pragma's cutoffs

  // Charts
  const projection = [{ year: 0, bear: price, base: price, bull: price }, ...dcf.price_targets.map((t) => ({ year: t.year, bear: t.bear_target, base: t.base_target, bull: t.bull_target }))];
  let valueBuild: PragValue["charts"]["value_build"] = null;
  const ladderMetric = dcf.metrics.find((m) => Math.abs(m.iv[1] - dcf.intrinsic_value_base) < 0.01) ?? dcf.metrics[0];
  if (ladderMetric && !dcf.dcf_skipped) {
    const shares = (() => { for (const l of ["Diluted Average Shares", "Basic Average Shares"]) { const v = data.income.rows[l]?.[0]; if (typeof v === "number" && v > 0) return v; } return safeFloat(info, "sharesOutstanding") || 1; })();
    const g = dcf.growth_rate_base, r = dcf.discount_rate, cf0 = ladderMetric.cf_y0 <= 0 ? Math.max(ladderMetric.cf_y0, 0.01) : ladderMetric.cf_y0;
    let pvCfs = 0;
    if (ladderMetric.is_flow) for (let y = 1; y <= 5; y++) pvCfs += projectWithReversion(cf0, g, y) / (1 + r) ** y;
    const pvTv = (projectWithReversion(cf0, g, 5) * ladderMetric.exits[1]) / (1 + r) ** 5;
    valueBuild = {
      pv_cash_flows: pyRound(pvCfs / shares, 2), pv_terminal: pyRound(pvTv / shares, 2), net_debt_per_share: pyRound(ladderMetric.net_debt / shares, 2),
      per_share: pyRound(Math.max((pvCfs + pvTv - ladderMetric.net_debt) / shares, 0), 2), metric: ladderMetric.label,
      terminal_share: pvCfs + pvTv > 0 ? pyRound(pvTv / (pvCfs + pvTv), 4) : 0,
    };
  }
  const metric = primaryMetricFor(engine);
  const points = (historicalMultiples(data).dated[metric] ?? []).slice().reverse();
  const sorted = points.map((p) => p.multiple).sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : null);
  const current = points.length ? points[points.length - 1].multiple : null;

  return {
    engine, sector: meta.sector, industry: meta.industry, engine_result: er, confidence,
    cis: { status: creditZ === null ? "unavailable" : "computed", credit_z: creditZ, adjuster: pyRound(cisAdj, 4), applied: cisApplied,
      ...(creditZ === null ? { reason: "No credit-spread series is collected yet." } : {}) },
    dcf, pulse_score: pyRound(pulse, 3), mos_z: mosZ === null ? null : pyRound(mosZ, 3),
    targets: { bear, base, bull }, current_price: pyRound(price, 2),
    v_deviation: vDev, pq_deviation: pqDev, adjusted_deviation: pyRound(adjDev, 4),
    pulse_grade: { grade: vDev, label: gradeLabel(vDev as never) }, pq_grade: { grade: pqDev, label: gradeLabel(pqDev as never) },
    charts: {
      projection, value_build: valueBuild,
      multiple_history: { metric, points, current, percentile: current !== null && sorted.length ? pyRound((sorted.filter((v) => v < current).length / sorted.length) * 100, 0) : null, p25: q(0.25), p75: q(0.75) },
    },
    notes,
  };
}
