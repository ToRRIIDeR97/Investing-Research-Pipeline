// P3: AC-10..AC-12 Pragma's grade bands, confidence and trend rules, ported.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ramp, series } from "./support";

const grade = () => import("../../../src/lib/research/rating/grade");
const confidence = () => import("../../../src/lib/research/rating/confidence");
const trend = () => import("../../../src/lib/research/rating/trend");
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("AC-10: grade bands and labels", async () => {
  const { GRADE_BANDS, gradeForDeviation } = await grade();
  assert.deepEqual(GRADE_BANDS.map((b) => b.grade), ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"]);
  assert.equal(GRADE_BANDS[0].label, "Deep discount");
  assert.equal(GRADE_BANDS[5].label, "Fair value");
  assert.equal(GRADE_BANDS.at(-1)!.below, null);
  assert.equal(gradeForDeviation(-0.5), "A+");
  assert.equal(gradeForDeviation(-0.4), "A");
  assert.equal(gradeForDeviation(0), "B-");
  assert.equal(gradeForDeviation(0.39), "D");
  assert.equal(gradeForDeviation(0.5), "F");
});

test("AC-10: adjusted and composite deviation", async () => {
  const { adjustedDeviation, compositeDeviation } = await grade();
  close(adjustedDeviation(80, 100, 100), -0.2);
  close(adjustedDeviation(80, 100, 64), -0.16);
  assert.equal(adjustedDeviation(0, 100, 80), 0);
  close(compositeDeviation({ adjustedDeviation: -0.2, price: 100, bear: 80, bull: 140, creditZ: null }), -0.16);
  close(compositeDeviation({ adjustedDeviation: -0.2, price: 100, bear: 80, bull: 140, creditZ: 1 }), -0.18);
  close(compositeDeviation({ adjustedDeviation: -0.2, price: 100, bear: 80, bull: 140, creditZ: 5 }), -0.2);
});

test("AC-11: confidence and data quality", async () => {
  const { ratingConfidence, dataQualityFrom } = await confidence();
  assert.equal(dataQualityFrom({ priceVerified: true, betaVerified: true }), "High");
  assert.equal(dataQualityFrom({ priceVerified: true, betaVerified: false }), "Medium");
  assert.equal(dataQualityFrom({ priceVerified: false, betaVerified: false }), "Low");
  assert.equal(ratingConfidence({ dataQuality: "High", yearsCaptured: 5, flagCount: 0 }), 93);
  assert.equal(ratingConfidence({ dataQuality: "Medium", yearsCaptured: 3, flagCount: 2 }), 62);
  assert.equal(ratingConfidence({ dataQuality: "Low", yearsCaptured: 1, flagCount: 5 }), 30);
});

const flatBench = series(Array(300).fill(100));

test("AC-12: a steady uptrend meets all nine conditions", async () => {
  const { trendRules } = await trend();
  const r = trendRules(series(ramp(300, 50, 150)), flatBench);
  assert.deepEqual(r.rules.map((x) => x.key), ["price_above_150d_sma", "price_above_200d_sma", "sma_150_above_200", "sma_200_trending_up",
    "sma_50_above_150_200", "price_above_50d_sma", "above_52w_low_30pct", "within_25pct_52w_high", "rs_rating"]);
  assert.deepEqual(r.rules.map((x) => x.status), Array(9).fill("pass"));
  assert.equal(r.passed, 9);
  assert.equal(r.evaluated, 9);
  assert.equal(r.score_label, "9/9 conditions met");
  assert.equal(r.rs_rating, 99);
  assert.equal(r.mansfield?.signal, "STRONG OUTPERFORMER");
});

test("AC-12: a steady downtrend meets none", async () => {
  const { trendRules } = await trend();
  const r = trendRules(series(ramp(300, 150, 50)), flatBench);
  assert.equal(r.passed, 0);
  assert.equal(r.evaluated, 9);
  assert.ok(r.rs_rating! < 70);
});

test("AC-12: short history leaves rules unavailable, not failed", async () => {
  const { trendRules } = await trend();
  const r = trendRules(series(ramp(100, 50, 60)), null);
  const status = Object.fromEntries(r.rules.map((x) => [x.key, x.status]));
  assert.equal(status.price_above_50d_sma, "pass");
  assert.equal(status.price_above_200d_sma, "unavailable");
  assert.equal(status.rs_rating, "unavailable");
  assert.ok(r.rules.filter((x) => x.status === "unavailable").every((x) => typeof x.reason === "string" && x.reason.length > 0));
  assert.equal(r.evaluated, 1);
  assert.equal(r.rs_rating, null);
  assert.equal(r.mansfield, null);
});
