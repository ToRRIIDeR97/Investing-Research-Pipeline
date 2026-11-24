/**
 * The `stock_rating` artifact: a code-built grade from the accepted valuation and the stored prices.
 * Agents never write it. See grade.ts, confidence.ts and trend.ts for the ported Pragma methods.
 */
import { closeOnSplitBasis, type SplitEvent } from "@/lib/market-data/price-history";
import { adjustedDeviation, compositeDeviation, gradeForDeviation, gradeLabel, type Grade } from "./grade";
import { dataQualityFrom, ratingConfidence, type DataQuality } from "./confidence";
import { trendRules, type Close, type TrendResult } from "./trend";

type Row = Record<string, any>;

export type StockRating = {
  artifact_type: "stock_rating";
  status: "rated" | "withheld";
  withheld_reason?: string;
  price: number | null;
  value_today: { bear: number | null; base: number | null; bull: number | null };
  raw_deviation: number | null;
  adjusted_deviation: number | null;
  data_quality: DataQuality;
  confidence: number | null;
  valuation_grade: Grade | null;
  valuation_label: string | null;
  composite_deviation: number | null;
  composite_grade: Grade | null;
  composite_label: string | null;
  macro: { credit_z: number | null; status: "computed" | "unavailable"; reason?: string };
  trend: TrendResult;
  method: string[];
};

const r4 = (n: number) => Number(n.toFixed(4));
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Daily closes restated on the latest bar's split basis (bars are stored on the basis of the day they were retrieved). */
export function splitAdjustedCloses(bars: Array<{ day: string; close: number; retrieved_day?: string }>, splits: SplitEvent[]): Close[] {
  const toDay = bars[bars.length - 1]?.day;
  if (!toDay) return [];
  return bars.map((bar) => ({ day: bar.day, close: closeOnSplitBasis(bar.close, bar.day, bar.retrieved_day ?? bar.day, toDay, splits) }));
}

const METHOD = [
  "Deviation = price ÷ base-case value per share today − 1 (negative: below value). Adjusted deviation = deviation × √(confidence ÷ 100).",
  "Grade bands (Pragma PragValue): A+ below −40%, A −25%, A- −15%, B+ −8%, B −3%, B- +3%, C+ +8%, C +15%, C- +25%, D +40%, F above.",
  "Confidence: 85 when the valuation price and beta are both verified, 65 when one is, 40 when neither; +8 for 5+ fiscal years, +3 for 3+; −3 per valuation sanity flag, at most −10.",
  "Combined = 0.55 × adjusted deviation + 0.25 × asymmetry (bull upside vs bear downside today, ±0.30) + 0.20 × macro (−0.10 × credit z, ±2).",
  "Trend (Pragma PragTrend): nine trend-template conditions on split-adjusted daily closes by the market-data cutoff; conditions without enough history are left out of the score.",
];

export function buildStockRating(input: {
  valuation: Row | null; priceHistory: Row | null; stockCloses: Close[]; benchmarkCloses: Close[] | null;
  yearsCaptured: number; creditZ?: number | null;
}): StockRating {
  const trend = trendRules(input.stockCloses, input.benchmarkCloses);
  const dataQuality = dataQualityFrom({
    priceVerified: input.priceHistory?.valuation_price?.verified === true,
    betaVerified: input.priceHistory?.beta?.verified === true,
  });
  const creditZ = num(input.creditZ);
  const macro: StockRating["macro"] = creditZ === null
    ? { credit_z: null, status: "unavailable", reason: "No credit-spread series is collected for runs yet; the macro term is 0." }
    : { credit_z: creditZ, status: "computed" };
  const v = input.valuation;
  const price = num(v?.current_market_price);
  const valueToday = { bear: num(v?.value_today_bear), base: num(v?.value_today_base), bull: num(v?.value_today_bull) };
  const withheld = (reason: string): StockRating => ({
    artifact_type: "stock_rating", status: "withheld", withheld_reason: reason, price, value_today: valueToday,
    raw_deviation: null, adjusted_deviation: null, data_quality: dataQuality, confidence: null,
    valuation_grade: null, valuation_label: null, composite_deviation: null, composite_grade: null, composite_label: null,
    macro, trend, method: METHOD,
  });
  if (!v) return withheld("No accepted valuation for this run.");
  if (v.valuation_status === "withheld") return withheld(`The valuation was withheld${v.withheld_reason ? `: ${v.withheld_reason}` : "."}`);
  if (!(price !== null && price > 0)) return withheld("The valuation has no positive market price.");
  if (!(valueToday.base !== null && valueToday.base > 0)) return withheld("The base case has no positive value per share today.");

  const confidence = ratingConfidence({
    dataQuality, yearsCaptured: input.yearsCaptured,
    flagCount: Array.isArray(v.sanity?.flags) ? v.sanity.flags.length : 0,
  });
  const adjusted = adjustedDeviation(price, valueToday.base, confidence);
  const composite = compositeDeviation({
    adjustedDeviation: adjusted, price,
    bear: valueToday.bear ?? valueToday.base, bull: valueToday.bull ?? valueToday.base, creditZ,
  });
  const valuationGrade = gradeForDeviation(adjusted);
  const compositeGrade = gradeForDeviation(composite);
  return {
    artifact_type: "stock_rating", status: "rated", price, value_today: valueToday,
    raw_deviation: r4(price / valueToday.base - 1), adjusted_deviation: r4(adjusted),
    data_quality: dataQuality, confidence,
    valuation_grade: valuationGrade, valuation_label: gradeLabel(valuationGrade),
    composite_deviation: r4(composite), composite_grade: compositeGrade, composite_label: gradeLabel(compositeGrade),
    macro, trend, method: METHOD,
  };
}
