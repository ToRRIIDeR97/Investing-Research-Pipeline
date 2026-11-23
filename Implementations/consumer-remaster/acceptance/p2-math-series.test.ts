// P2: AC-6 chart maths, AC-7 price series.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";

const math = () => import("../../../src/lib/ui/chart-math");
const series = () => import("../../../src/lib/market-data/price-series");
const SOFI = { bear: 1.04, base: 8.8, bull: 14.92 };

test("AC-6: formatGap", async () => {
  const { formatGap } = await math();
  assert.equal(formatGap(-0.3838), "−38%");
  assert.equal(formatGap(0.0448), "+4.5%");
  assert.equal(formatGap(-0.927), "−93%");
  assert.equal(formatGap(0), "0%");
  assert.equal(formatGap(null), "—");
});

test("AC-6: gapPct", async () => {
  const { gapPct } = await math();
  assert.ok(Math.abs((gapPct(8.8, 14.28) as number) + 0.38375) < 1e-4);
  assert.equal(gapPct(null, 14.28), null);
  assert.equal(gapPct(8.8, 0), null);
});

test("AC-6: blendValue for SoFi", async () => {
  const { blendValue } = await math();
  assert.equal(Number(blendValue(SOFI, 0)!.toFixed(2)), 4.92);
  assert.equal(Number(blendValue(SOFI, 0.5)!.toFixed(2)), 8.39);
  assert.equal(Number(blendValue(SOFI, 1)!.toFixed(2)), 11.86);
  assert.equal(Number(blendValue(SOFI, 7)!.toFixed(2)), 11.86, "t is clamped");
  assert.equal(blendValue({ ...SOFI, bull: null }, 0.5), null);
});

test("AC-6: nearestIndex and cursorStep", async () => {
  const { nearestIndex, cursorStep } = await math();
  assert.equal(nearestIndex(0, 5, 0, 100), 0);
  assert.equal(nearestIndex(60, 5, 0, 100), 2);
  assert.equal(nearestIndex(500, 5, 0, 100), 4);
  assert.equal(nearestIndex(10, 0, 0, 100), -1);
  assert.equal(cursorStep(3, "ArrowLeft", 10), 2);
  assert.equal(cursorStep(9, "ArrowRight", 10), 9);
  assert.equal(cursorStep(5, "Home", 10), 0);
  assert.equal(cursorStep(5, "End", 10), 9);
  assert.equal(cursorStep(5, "PageUp", 30), 0);
  assert.equal(cursorStep(5, "PageDown", 30), 15);
  assert.equal(cursorStep(5, "a", 10), 5);
});

test("AC-6: donutSegments", async () => {
  const { donutSegments } = await math();
  const s = donutSegments([5, 2, 1, 1, 7], 0);
  assert.equal(s.length, 5);
  assert.ok(Math.abs(s[0].length - 5 / 16) < 1e-9);
  assert.ok(Math.abs(s[1].start - 5 / 16) < 1e-9);
  assert.ok(Math.abs(s.reduce((a, x) => a + x.length, 0) - 1) < 1e-9);
  assert.deepEqual(donutSegments([0, 0], 0.01), []);
  assert.deepEqual(donutSegments([], 0.01), []);
  assert.ok(donutSegments([1, 0], 0.01)[1].length === 0);
});

const bars = [
  { day: "2026-11-17", close: 14.28 }, { day: "2026-05-20", close: 10 }, { day: "2026-08-18", close: 15.01 },
  { day: "2026-11-17", close: 14.28 }, { day: "2025-11-17", close: 8 }, { day: "2026-10-20", close: 13 },
];

test("AC-7: pricePoints sorts, dedupes and windows by calendar months", async () => {
  const { pricePoints, RANGES } = await series();
  assert.deepEqual([...RANGES], ["1M", "3M", "6M", "1Y", "5Y"]);
  assert.deepEqual(pricePoints(bars, "1M").map((p) => p.day), ["2026-10-20", "2026-11-17"]);
  assert.deepEqual(pricePoints(bars, "6M").map((p) => p.day), ["2026-05-20", "2026-08-18", "2026-10-20", "2026-11-17"]);
  assert.equal(pricePoints(bars, "1Y")[0].day, "2025-11-17");
  assert.deepEqual(pricePoints([], "6M"), []);
});

test("AC-7: seriesChange", async () => {
  const { seriesChange } = await series();
  assert.ok(Math.abs((seriesChange([{ day: "a", close: 10 }, { day: "b", close: 14.28 }]) as number) - 0.428) < 1e-9);
  assert.equal(seriesChange([{ day: "a", close: 10 }]), null);
});
