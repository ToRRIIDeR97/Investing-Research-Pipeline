/**
 * Rating confidence, ported from Pragma's `_compute_confidence_score`: a base by data quality, a bonus
 * for history depth and a capped penalty for structural flags. Here data quality comes from whether the
 * valuation price and the beta were verified, and flags are the valuation's sanity flags.
 */

export type DataQuality = "High" | "Medium" | "Low";

export function dataQualityFrom(input: { priceVerified: boolean; betaVerified: boolean }): DataQuality {
  const verified = Number(input.priceVerified) + Number(input.betaVerified);
  return verified === 2 ? "High" : verified === 1 ? "Medium" : "Low";
}

/** 0-100: High 85, Medium 65, Low 40; +8 for 5+ fiscal years, +3 for 3+; −3 per flag, at most −10. */
export function ratingConfidence(input: { dataQuality: DataQuality; yearsCaptured: number; flagCount: number }): number {
  let score = { High: 85, Medium: 65, Low: 40 }[input.dataQuality];
  if (input.yearsCaptured >= 5) score += 8;
  else if (input.yearsCaptured >= 3) score += 3;
  score -= Math.min(Math.max(0, input.flagCount) * 3, 10);
  return Math.round(Math.max(0, Math.min(100, score)));
}
