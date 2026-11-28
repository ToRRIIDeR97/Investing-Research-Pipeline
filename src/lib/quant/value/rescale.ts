/**
 * Reruns PragValue's DCF at growth rates the reader chose (the Value tab's growth controls), with everything else as
 * the model set it: each metric's base cash flow, exit multiples, net debt and weight, the discount rate and the
 * shares. Same arithmetic as `computeDcf` (`targetsFor` per metric, then the weighted median), so the model's own
 * growth reproduces the model's values. Pure, and small enough to run in the browser on every slider move.
 */
import { pyRound, targetsFor, weightedMedian, type DcfResult } from "./model";

export type Growth = { bear: number; base: number; bull: number };
export type RescaledDcf = Pick<DcfResult, "intrinsic_value_bear" | "intrinsic_value_base" | "intrinsic_value_bull" | "mos_bear" | "mos_base" | "mos_bull"
  | "growth_rate_bear" | "growth_rate_base" | "growth_rate_bull" | "price_targets">;

/** Growth the controls allow, per year: −30% to +60%. */
export const GROWTH_MIN = -0.3, GROWTH_MAX = 0.6;
const clampGrowth = (g: number) => Math.min(GROWTH_MAX, Math.max(GROWTH_MIN, Number.isFinite(g) ? g : 0));

export function rescaleDcf(dcf: DcfResult, growth: Growth, price: number): RescaledDcf {
  // A case left at the model's (rounded) rate uses the model's unrounded rate, so it reproduces the model exactly.
  const raw = dcf.dcf_growth_raw;
  const pickRate = (k: "bear" | "base" | "bull") => (raw && Math.abs(growth[k] - dcf[`growth_rate_${k}`]) < 1e-9 ? raw[k] : clampGrowth(growth[k]));
  const g = { bear: pickRate("bear"), base: pickRate("base"), bull: pickRate("bull") };
  const discount = dcf.dcf_discount_raw ?? dcf.discount_rate;
  const rates = { growth_rate_bear: pyRound(g.bear, 4), growth_rate_base: pyRound(g.base, 4), growth_rate_bull: pyRound(g.bull, 4) };
  if (dcf.dcf_skipped || !dcf.metrics.length) {
    return { ...rates, intrinsic_value_bear: dcf.intrinsic_value_bear, intrinsic_value_base: dcf.intrinsic_value_base, intrinsic_value_bull: dcf.intrinsic_value_bull,
      mos_bear: dcf.mos_bear, mos_base: dcf.mos_base, mos_bull: dcf.mos_bull, price_targets: dcf.price_targets };
  }
  const shares = dcf.dcf_shares ?? 1;
  const runs = dcf.metrics.map((m) => ({ m, ...targetsFor(m.is_flow, m.cf_y0, { bear: [g.bear, m.exits[0]], base: [g.base, m.exits[1]], bull: [g.bull, m.exits[2]] }, m.net_debt, shares, price, discount) }));
  // computeDcf keeps only metrics whose base value is positive; with one metric (the fallback) it is used as is.
  const kept = runs.length === 1 ? runs : runs.filter((r) => r.iv.base > 0);
  const use = kept.length ? kept : runs;
  const ws = use.map((r) => r.m.weight);
  const pick = (k: "bear" | "base" | "bull") => (use.length === 1 ? use[0].iv[k] : pyRound(weightedMedian(use.map((r) => r.iv[k]), ws), 2));
  const bear = pick("bear"), base = pick("base"), bull = pick("bull");
  const mos = (v: number) => (v > 0 ? pyRound((v - price) / v, 4) : 0);
  const ladder = use.reduce((a, b) => (Math.abs(b.iv.base - base) < Math.abs(a.iv.base - base) ? b : a)).ladder;
  return { ...rates, intrinsic_value_bear: bear, intrinsic_value_base: base, intrinsic_value_bull: bull, mos_bear: mos(bear), mos_base: mos(base), mos_bull: mos(bull), price_targets: ladder };
}

/** The chart's forward value path for rescaled targets (each discounted target compounded to its own year). */
export function forwardProjection(targets: DcfResult["price_targets"], discount: number, price: number) {
  // computePragValue compounds with the rounded discount_rate; pass the same so the chart matches the model's.
  const fwd = (v: number, year: number) => pyRound(v * (1 + discount) ** year, 2);
  return [{ year: 0, bear: price, base: price, bull: price }, ...targets.map((t) => ({ year: t.year, bear: fwd(t.bear_target, t.year), base: fwd(t.base_target, t.year), bull: fwd(t.bull_target, t.year) }))];
}
