// V3: AC-10..AC-12 rating edges: band edges, asymmetry caps, clamps, splits in trend data, flat lines.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ramp, series } from "./support";

const grade = () => import("../../../src/lib/research/rating/grade");
const confidence = () => import("../../../src/lib/research/rating/confidence");
const trend = () => import("../../../src/lib/research/rating/trend");
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("AC-10: every cutoff is exclusive and ordered", async () => {
  const { GRADE_BANDS, gradeForDeviation } = await grade();
  const cutoffs = GRADE_BANDS.slice(0, -1).map((b) => b.below as number);
  assert.deepEqual(cutoffs, [-0.4, -0.25, -0.15, -0.08, -0.03, 0.03, 0.08, 0.15, 0.25, 0.4]);
  GRADE_BANDS.slice(0, -1).forEach((band, i) => {
    assert.equal(gradeForDeviation((band.below as number) - 1e-9), band.grade);
    assert.equal(gradeForDeviation(band.below as number), GRADE_BANDS[i + 1].grade);
  });
  assert.equal(GRADE_BANDS.at(-1)!.label, "Deep premium");
});

test("AC-10: asymmetry is capped both ways, and a zero bear return counts as symmetric", async () => {
  const { compositeDeviation } = await grade();
  // bull/|bear| = 10 → clamped to 5 → −min(0.8, 0.3) = −0.3
  close(compositeDeviation({ adjustedDeviation: 0, price: 100, bear: 99, bull: 110, creditZ: null }), -0.075);
  // bull below zero → ratio 0 → +0.3
  close(compositeDeviation({ adjustedDeviation: 0, price: 100, bear: 50, bull: 90, creditZ: null }), 0.075);
  // bear return 0 → ratio 1 → 0
  close(compositeDeviation({ adjustedDeviation: 0.1, price: 100, bear: 100, bull: 130, creditZ: null }), 0.055);
  // negative credit z (loose credit) raises the deviation
  close(compositeDeviation({ adjustedDeviation: 0, price: 100, bear: 100, bull: 100, creditZ: -3 }), 0.04);
});

test("AC-10: a zero base value gives no deviation", async () => {
  const { adjustedDeviation } = await grade();
  assert.equal(adjustedDeviation(100, 0, 90), 0);
});

test("AC-11: confidence clamps and caps the flag penalty", async () => {
  const { ratingConfidence } = await confidence();
  assert.equal(ratingConfidence({ dataQuality: "High", yearsCaptured: 10, flagCount: 100 }), 83);
  assert.equal(ratingConfidence({ dataQuality: "Low", yearsCaptured: 0, flagCount: 0 }), 40);
  assert.equal(ratingConfidence({ dataQuality: "Medium", yearsCaptured: 4, flagCount: 1 }), 65);
  assert.ok(Number.isInteger(ratingConfidence({ dataQuality: "Medium", yearsCaptured: 2, flagCount: 0 })));
});

test("AC-12: a flat line fails the strict comparisons and the 30% off-lows rule", async () => {
  const { trendRules } = await trend();
  const r = trendRules(series(Array(300).fill(100)), series(Array(300).fill(100)));
  const status = Object.fromEntries(r.rules.map((x) => [x.key, x.status]));
  assert.equal(status.price_above_200d_sma, "fail");
  assert.equal(status.sma_200_trending_up, "fail");
  assert.equal(status.above_52w_low_30pct, "fail");
  assert.equal(status.within_25pct_52w_high, "pass");
  assert.equal(status.rs_rating, "fail");
  assert.equal(r.rs_rating, 50);
  assert.equal(r.mansfield?.value, 0);
  assert.equal(r.mansfield?.signal, "UNDERPERFORMING");
});

test("AC-12: the 200-day slope needs 241 bars and two rising months", async () => {
  const { trendRules } = await trend();
  const status = (closes: number[]) => trendRules(series(closes), null).rules.find((x) => x.key === "sma_200_trending_up")!.status;
  assert.equal(status(ramp(240, 50, 100)), "unavailable");
  assert.equal(status(ramp(241, 50, 100)), "pass");
  // Rising for most of the series, then a crash: the last month of the 200-day average falls.
  assert.equal(status([...ramp(260, 50, 150), ...Array(40).fill(1)]), "fail");
});

test("AC-12: a benchmark with too little history leaves RS unavailable but trend rules evaluated", async () => {
  const { trendRules } = await trend();
  const r = trendRules(series(ramp(300, 50, 150)), series(Array(100).fill(100)));
  assert.equal(r.rules.find((x) => x.key === "rs_rating")!.status, "unavailable");
  assert.equal(r.evaluated, 8);
  assert.equal(r.passed, 8);
  assert.equal(r.score_label, "8/8 conditions met");
});
