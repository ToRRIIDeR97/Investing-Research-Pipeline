// P3: AC-7 Weinstein stage, AC-8 pocket pivots and VCP, rebased performance (ported from Pragma's pragtrend.py and
// pattern_detector.py).
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ramp, series } from "./support";

const bars = (closes: number[], volumes?: (number | null)[]) => series(closes).map((b, i) => ({ ...b, volume: volumes ? volumes[i] : 1_000_000 }));

test("AC-7: a steady advance is stage 2, a steady decline stage 4, a flat line stage 1", async () => {
  const { computeStage } = await import("../../../src/lib/quant/trend/stage");
  const up = computeStage(bars(ramp(400, 50, 150)))!;
  assert.equal(up.stage, "STAGE_2_ADVANCE");
  assert.equal(up.stage_number, 2);
  assert.ok(up.weeks_in_stage > 4, `weeks ${up.weeks_in_stage}`);
  assert.equal(computeStage(bars(ramp(400, 150, 50)))!.stage, "STAGE_4_DECLINE");
  assert.equal(computeStage(bars(Array(400).fill(100)))!.stage, "STAGE_1_BASE");
  assert.equal(computeStage(bars(ramp(150, 50, 60))), null, "fewer than 200 bars");
});

test("AC-7: the weekly stage history covers up to 52 weeks, newest last", async () => {
  const { stageHistory } = await import("../../../src/lib/quant/trend/stage");
  const h = stageHistory(bars(ramp(500, 50, 150)));
  assert.ok(h.length > 0 && h.length <= 52);
  assert.equal(h[h.length - 1].stage_number, 2);
  assert.ok(h.every((w, i) => i === 0 || w.week > h[i - 1].week));
});

test("AC-8: a pocket pivot is an up close on volume above the prior 10 sessions' biggest down-day volume", async () => {
  const { detectPocketPivots } = await import("../../../src/lib/quant/trend/patterns");
  const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1) + i * 0.1);
  const volumes = closes.map(() => 1_000_000);
  closes[38] = closes[37] + 3; volumes[38] = 5_000_000;
  const r = detectPocketPivots(bars(closes, volumes));
  assert.equal(r.status, "computed");
  assert.ok(r.events.some((e) => e.day === series(closes)[38].day && e.volume_ratio === 5));
  const none = detectPocketPivots(bars(closes, closes.map(() => null)));
  assert.equal(none.status, "unavailable");
});

test("AC-8: VCP reports successive pullback depths and the 30-week check", async () => {
  const { detectVcp } = await import("../../../src/lib/quant/trend/patterns");
  // A long rise, then three pullbacks of shrinking depth (18%, 9%, 4%) inside the last 26 weeks.
  const rise = ramp(200, 40, 100);
  const leg = (from: number, depth: number, n = 10) => [...ramp(n, from, from * (1 - depth)), ...ramp(n, from * (1 - depth), from)];
  const closes = [...rise, ...leg(100, 0.18), ...leg(100, 0.09), ...leg(100, 0.04), ...ramp(10, 100, 101)];
  const r = detectVcp(bars(closes));
  assert.equal(r.status, "computed");
  assert.equal(r.above_30w_sma, true);
  assert.ok(r.contractions.length >= 2);
  const depths = r.contractions.map((c) => c.depth_pct);
  assert.ok(depths.every((d, i) => i === 0 || d < depths[i - 1]), `depths ${depths}`);
  assert.ok(r.quality === "FORMING" || r.quality === "TIGHT");
});

// Parity with Pragma's Python (fixtures/pragma_parity.py runs compute_stage, detect_pocket_pivot, detect_vcp).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const fixtures = join(__dirname, "../fixtures");
for (const file of readdirSync(join(fixtures, "cases")).filter((f) => f.endsWith(".json"))) {
  test(`AC-7/AC-8: stage and pattern parity with Pragma, ${file.replace(".json", "")}`, async () => {
    const { computeStage } = await import("../../../src/lib/quant/trend/stage");
    const { detectPocketPivots, detectVcp } = await import("../../../src/lib/quant/trend/patterns");
    const history = JSON.parse(readFileSync(join(fixtures, "cases", file), "utf8")).data.history;
    const g = JSON.parse(readFileSync(join(fixtures, "golden", `trend-${file}`), "utf8"));
    const stage = computeStage(history);
    if (g.stage === null) assert.equal(stage, null);
    else {
      assert.equal(stage!.stage, g.stage.stage);
      assert.equal(stage!.weeks_in_stage, g.stage.weeks_in_stage);
      assert.equal(stage!.confidence, g.stage.confidence);
      assert.ok(Math.abs(stage!.sma_30w_slope_pct - g.stage.sma_30w_slope_pct) <= 0.011);
      assert.ok(Math.abs(stage!.price_vs_sma_30w_pct - g.stage.price_vs_sma_30w_pct) <= 0.011);
    }
    const pp = detectPocketPivots(history);
    assert.deepEqual(pp.events.map((e) => [e.day, e.volume_ratio]), g.pocket_pivots.map((e: any) => [e.day, e.volume_ratio]));
    const vcp = detectVcp(history);
    assert.equal(vcp.quality, g.vcp.quality);
    assert.equal(vcp.above_30w_sma, g.vcp.above_30w_sma);
    assert.deepEqual(vcp.contractions.map((c) => c.depth_pct), g.vcp.depths);
  });
}

test("rebased performance starts at 100 a year back and keeps the ratio", async () => {
  const { rebased } = await import("../../../src/lib/quant/trend/rebased");
  const s = series(ramp(300, 50, 100));
  const r = rebased(s, 252);
  assert.equal(r[0].value, 100);
  assert.ok(Math.abs(r[r.length - 1].value - (100 * 100) / s[s.length - 252].close) < 1e-6);
});
