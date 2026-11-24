/**
 * Valuation grade bands, ported from Pragma's PragValue deviation-band system
 * (`pragma-web/api/app/services/pulsevalue.py`, DEVIATION_BAND_CUTOFFS and _compute_pq_deviation_band).
 *
 * Deviation is price over value, less one: negative means the stock trades below its value. The valuation
 * grade scales it by the square root of confidence; the combined grade adds bull/bear asymmetry and a
 * macro credit term with Pragma's weights (0.55, 0.25, 0.20).
 */

export type Grade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F";

/** Bands in order; a deviation belongs to the first band whose `below` is strictly greater. F is open-ended. */
export const GRADE_BANDS: ReadonlyArray<{ grade: Grade; below: number | null; label: string }> = [
  { grade: "A+", below: -0.4, label: "Deep discount" },
  { grade: "A", below: -0.25, label: "Significant discount" },
  { grade: "A-", below: -0.15, label: "Moderate discount" },
  { grade: "B+", below: -0.08, label: "Slight discount" },
  { grade: "B", below: -0.03, label: "Marginal discount" },
  { grade: "B-", below: 0.03, label: "Fair value" },
  { grade: "C+", below: 0.08, label: "Marginal premium" },
  { grade: "C", below: 0.15, label: "Moderate premium" },
  { grade: "C-", below: 0.25, label: "Elevated premium" },
  { grade: "D", below: 0.4, label: "Significant premium" },
  { grade: "F", below: null, label: "Deep premium" },
];

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

export function gradeForDeviation(deviation: number): Grade {
  return GRADE_BANDS.find((band) => band.below !== null && deviation < band.below)?.grade ?? "F";
}

export function gradeLabel(grade: Grade): string {
  return GRADE_BANDS.find((band) => band.grade === grade)!.label;
}

/** (price / value − 1) × √(confidence / 100); 0 when price or value is 0. */
export function adjustedDeviation(price: number, baseValue: number, confidence: number): number {
  if (!price || !baseValue) return 0;
  return (price / baseValue - 1) * Math.sqrt(confidence / 100);
}

/**
 * 0.55 × adjusted deviation + 0.25 × asymmetry + 0.20 × macro. Asymmetry rewards more upside to bull than
 * downside to bear (capped at ±0.30); macro is −0.10 × the credit z-score clamped to ±2, or 0 without one.
 */
export function compositeDeviation(input: { adjustedDeviation: number; price: number; bear: number; bull: number; creditZ: number | null }): number {
  const { price } = input;
  const bearReturn = price > 0 ? input.bear / price - 1 : 0;
  const bullReturn = price > 0 ? input.bull / price - 1 : 0;
  const ratio = bearReturn !== 0 ? clamp(bullReturn / Math.abs(bearReturn), 0, 5) : 1;
  const asymmetry = ratio >= 1 ? -Math.min((ratio - 1) * 0.2, 0.3) : Math.min((1 - ratio) * 0.3, 0.3);
  const macro = input.creditZ === null || !Number.isFinite(input.creditZ) ? 0 : -clamp(input.creditZ, -2, 2) * 0.1;
  return input.adjustedDeviation * 0.55 + asymmetry * 0.25 + macro * 0.2;
}
