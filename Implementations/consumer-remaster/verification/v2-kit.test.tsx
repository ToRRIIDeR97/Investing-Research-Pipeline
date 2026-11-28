// V2 (P2): edge cases for the maths, the series window and the components.
import "./v-support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";
const SOFI = { bear: 1.04, base: 8.8, bull: 14.92 };

test("V2/AC-6: formatGap at the one-decimal boundary", async () => {
  const { formatGap } = await import("../../../src/lib/ui/chart-math");
  assert.equal(formatGap(0.1), "+10%");
  assert.equal(formatGap(-0.05), "−5.0%");
  assert.equal(formatGap(0.004), "+0.4%");
});

test("V2/AC-6: gapPct rejects a negative price; blendValue clamps below 0", async () => {
  const { gapPct, blendValue } = await import("../../../src/lib/ui/chart-math");
  assert.equal(gapPct(8.8, -1), null);
  assert.equal(Number(blendValue(SOFI, -3)!.toFixed(2)), 4.92);
});

test("V2/AC-6: a single point and a large gap", async () => {
  const { nearestIndex, donutSegments } = await import("../../../src/lib/ui/chart-math");
  assert.equal(nearestIndex(73, 1, 0, 100), 0);
  const s = donutSegments([1, 9], 0.2);
  assert.equal(s[0].length, 0, "a share smaller than the gap draws nothing, never negative");
  assert.ok(Math.abs(s[1].start - 0.1) < 1e-9);
  assert.ok(Math.abs(s[1].length - 0.7) < 1e-9);
});

test("V2/AC-7: month-end windows clamp to the shorter month; 5Y reaches back five years", async () => {
  const { pricePoints } = await import("../../../src/lib/market-data/price-series");
  const bars = [{ day: "2026-02-27", close: 1 }, { day: "2026-02-28", close: 2 }, { day: "2026-03-31", close: 3 }, { day: "2021-03-31", close: 4 }, { day: "2021-03-30", close: 5 }];
  assert.deepEqual(pricePoints(bars, "1M").map((p) => p.day), ["2026-02-28", "2026-03-31"]);
  assert.equal(pricePoints(bars, "5Y")[0].day, "2021-03-31");
});

test("V2/AC-7: duplicate days keep the last close given", async () => {
  const { pricePoints } = await import("../../../src/lib/market-data/price-series");
  const pts = pricePoints([{ day: "2026-11-17", close: 14 }, { day: "2026-11-17", close: 14.28 }], "1M");
  assert.deepEqual(pts, [{ day: "2026-11-17", close: 14.28 }]);
});

test("V2/AC-8: ranges are case-sensitive", async () => {
  const { GET } = await import("../../../src/app/api/assets/[id]/prices/route");
  const id = "8b0d5c1e-3f7a-4c2e-9b1d-2a6f4e8c7d10";
  const res = await GET(new NextRequest(`http://localhost/api/assets/${id}/prices?range=6m`), { params: Promise.resolve({ id }) });
  assert.equal(res.status, 400);
});

test("V2/AC-9: one price point shows the number but no line", async () => {
  const { PriceChart } = await import("../../../src/components/interactive");
  const html = renderToStaticMarkup(<PriceChart points={[{ day: "2026-11-17", close: 14.28 }]} currency="USD" />);
  assert.match(html, /\$14\.28/);
  assert.match(html, /Not enough history for a chart/);
  assert.doesNotMatch(html, /<polyline/);
});

test("V2/AC-9: the meter says 'above' for the bull case and handles a missing value", async () => {
  const { ValueMeter, ScenarioPicker } = await import("../../../src/components/interactive");
  assert.match(renderToStaticMarkup(<ValueMeter price={14.28} values={SOFI} selected="bull" />), /aria-label="Bull case \$14\.92, 4\.5% above the \$14\.28 price"/);
  assert.match(renderToStaticMarkup(<ValueMeter price={14.28} values={{ ...SOFI, bear: null }} selected="bear" />), /No price to compare/);
  assert.match(renderToStaticMarkup(<ScenarioPicker values={{ ...SOFI, bear: null }} price={14.28} selected="base" onSelect={() => {}} />), /—/);
});

test("V2/AC-9: empty donut and runs say so; no budget, no cap", async () => {
  const { FindingsDonut, RunsBars } = await import("../../../src/components/interactive");
  assert.match(renderToStaticMarkup(<FindingsDonut groups={[]} />), /No findings/);
  assert.match(renderToStaticMarkup(<RunsBars runs={[]} />), /No runs yet/);
  assert.doesNotMatch(renderToStaticMarkup(<RunsBars runs={[{ id: "a", label: "1 Oct", outcome: "Completed", cost: 1 }]} />), /cap/);
});

test("V2/AC-9: the blend never labels itself as the report's value", async () => {
  const { BlendSlider } = await import("../../../src/components/interactive");
  assert.doesNotMatch(renderToStaticMarkup(<BlendSlider values={SOFI} price={14.28} />), /Report \$/);
});
