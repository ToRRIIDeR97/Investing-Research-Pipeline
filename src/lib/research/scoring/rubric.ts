/**
 * The research-depth rubric shared by the human review form, the opt-in LLM judge and eval:score. Each dimension
 * is scored 0-4. Level 3 is the JD example ("preliminary but complete" in the user's words); level 4 is reserved
 * for depth beyond it, so the scale does not stop at JD.
 */
export const RUBRIC_LEVELS = [
  "0: absent",
  "1: mentioned without analysis",
  "2: partial or template-level analysis",
  "3: complete at the level of the JD example: computed, positioned against history, tied to value",
  "4: deeper than the JD example: more evidence, computation or tested alternatives",
] as const;

export interface RubricDimension { id: string; label: string; anchor3: string; depth_checks: string[] }

export const RUBRIC_DIMENSIONS: RubricDimension[] = [
  { id: "framing", label: "Framing and decisive insight", depth_checks: ["decisive_insight"],
    anchor3: "One central insight reframes the question (JD: two engines, will management let core economics accrue?), with a classification and confidence." },
  { id: "ownership", label: "What the investor owns", depth_checks: ["ownership_and_control"],
    anchor3: "The claim chain from security to cash, share classes, voting versus economic control, and which assets get zero value." },
  { id: "business_economics", label: "Business and segment economics", depth_checks: ["segment_economics", "demand_backdrop"],
    anchor3: "Segments split into earners and burners with revenue, operating income and margins; value chains from demand to FCF; the end-demand constraint." },
  { id: "history", label: "History and current position", depth_checks: ["history_statistics"],
    anchor3: "Twenty-quarter statistics (median, range) with the current value positioned against them." },
  { id: "cash_and_capital", label: "Cash conversion and capital allocation", depth_checks: ["cash_conversion", "working_capital", "capital_allocation"],
    anchor3: "FCF/NI conversion, working-capital days, net cash with haircuts, buybacks and share count change." },
  { id: "moat", label: "Moat tested against attacks", depth_checks: ["moat_attacks"],
    anchor3: "Each moat source rated, with an attack table and competitor numbers, and a residual-moat conclusion." },
  { id: "management", label: "Management and governance", depth_checks: ["management_assessment"],
    anchor3: "Execution, balance sheet, capital allocation and governance scored separately, with evidence." },
  { id: "forecasts", label: "Process-driven scenarios", depth_checks: ["tail_below_bear"],
    anchor3: "Bear, base and bull per operating dimension, modeled normalized FCF per case, and impairment cases below bear." },
  { id: "valuation", label: "Valuation and cross-checks", depth_checks: ["valuation_matrix", "reverse_valuation", "fcf_yield_cross_check", "no_rerating_return"],
    anchor3: "An operating case x valuation assumption matrix, reverse DCF in FCF-growth terms, an FCF-yield cross-check and the no-rerating return." },
  { id: "risk_and_monitoring", label: "Risk, monitoring and what would change my mind", depth_checks: ["thesis_breakers", "monitoring_dashboard", "what_would_change_my_mind", "scorecard_confidence"],
    anchor3: "Thesis breakers with thresholds, a five-number dashboard, a scorecard and what would change the analyst's mind." },
];
const IDS = new Set(RUBRIC_DIMENSIONS.map((d) => d.id));

/** Human ratings as stored: integers 0-4 for known dimensions only. Throws on anything else. */
export function parseRubricRatings(value: unknown): Record<string, number> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Rubric ratings must be an object of dimension to 0-4 score");
  const ratings: Record<string, number> = {};
  for (const [key, score] of Object.entries(value as Record<string, unknown>)) {
    if (score === "" || score === null || score === undefined) continue;
    const n = Number(score);
    if (!IDS.has(key)) throw new Error(`Unknown rubric dimension ${key}`);
    if (!Number.isInteger(n) || n < 0 || n > 4) throw new Error(`Rubric score for ${key} must be an integer from 0 to 4`);
    ratings[key] = n;
  }
  return Object.keys(ratings).length ? ratings : null;
}

/** Share of dimensions rated by both where the scores are within one point; null when none overlap. */
export function ratingAgreement(a: Record<string, number>, b: Record<string, number>) {
  const shared = Object.keys(a).filter((key) => key in b);
  return shared.length ? shared.filter((key) => Math.abs(a[key] - b[key]) <= 1).length / shared.length : null;
}
