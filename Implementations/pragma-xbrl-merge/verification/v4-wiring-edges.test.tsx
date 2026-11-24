// V4: AC-13..AC-15 wiring edges: missing inputs, unverified data, version selection, empty trend.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ramp, series } from "./support";

const build = () => import("../../../src/lib/research/rating/build");
const valuation = { valuation_status: "complete", current_market_price: 50, value_today_bear: 30, value_today_base: 40, value_today_bull: 60, sanity: { flags: [] } };

test("AC-13: an overvalued stock with unverified data grades down, with lower confidence", async () => {
  const { buildStockRating } = await build();
  const r = buildStockRating({ valuation, priceHistory: { valuation_price: { verified: false }, beta: { verified: false } },
    stockCloses: [], benchmarkCloses: [], yearsCaptured: 2 });
  assert.equal(r.status, "rated");
  assert.equal(r.data_quality, "Low");
  assert.equal(r.confidence, 40);
  assert.equal(r.raw_deviation, 0.25);
  assert.equal(r.adjusted_deviation, 0.1581);
  assert.equal(r.valuation_grade, "C-");
  assert.equal(r.trend.evaluated, 0);
  assert.equal(r.trend.score_label, "0/0 conditions met");
});

test("AC-13: missing price history artifact counts as unverified; non-positive values withhold", async () => {
  const { buildStockRating } = await build();
  const r = buildStockRating({ valuation, priceHistory: null, stockCloses: [], benchmarkCloses: null, yearsCaptured: 5 });
  assert.equal(r.data_quality, "Low");
  for (const bad of [{ current_market_price: 0 }, { value_today_base: -5 }, { value_today_base: null }]) {
    const w = buildStockRating({ valuation: { ...valuation, ...bad }, priceHistory: null, stockCloses: [], benchmarkCloses: null, yearsCaptured: 5 });
    assert.equal(w.status, "withheld", JSON.stringify(bad));
    assert.equal(w.adjusted_deviation, null);
    assert.equal(w.valuation_grade, null);
  }
});

test("AC-13: the rating is plain JSON (stored as content_json)", async () => {
  const { buildStockRating } = await build();
  const r = buildStockRating({ valuation, priceHistory: null, stockCloses: series(ramp(300, 10, 20)), benchmarkCloses: series(Array(300).fill(1)), yearsCaptured: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("AC-14: measures use the newest rating and explain gaps", async () => {
  const { buildStockRating } = await build();
  const { measureValue } = await import("../../../src/lib/research/checklist/measures");
  const old = buildStockRating({ valuation, priceHistory: null, stockCloses: [], benchmarkCloses: null, yearsCaptured: 5 });
  const withheld = buildStockRating({ valuation: null, priceHistory: null, stockCloses: [], benchmarkCloses: null, yearsCaptured: 5 });
  const artifacts = [
    { artifact_type: "stock_rating", artifact_version: 1, content_json: old },
    { artifact_type: "stock_rating", artifact_version: 2, content_json: withheld },
  ];
  const dev = measureValue("valuation_deviation_pct" as any, artifacts);
  assert.equal(dev.value, null);
  assert.match((dev as any).reason, /withheld/i);
  const trend = measureValue("trend_score_pct" as any, artifacts);
  assert.equal(trend.value, null, "nothing evaluated");
});

test("AC-15: the panel uses the newest rating and shows the combined grade", async () => {
  const { buildStockRating } = await build();
  const { StockRatingPanel } = await import("../../../src/components/report/stock-rating");
  const first = buildStockRating({ valuation: null, priceHistory: null, stockCloses: [], benchmarkCloses: null, yearsCaptured: 5 });
  const second = buildStockRating({ valuation, priceHistory: { valuation_price: { verified: true }, beta: { verified: true } },
    stockCloses: [], benchmarkCloses: null, yearsCaptured: 5 });
  const html = renderToStaticMarkup(<StockRatingPanel artifacts={[
    { artifact_type: "stock_rating", artifact_version: 2, content_json: second },
    { artifact_type: "stock_rating", artifact_version: 1, content_json: first },
  ]} />);
  assert.doesNotMatch(html, /withheld/i);
  assert.match(html, new RegExp(String(second.composite_grade).replace("+", "\\+")));
  assert.match(html, /0\/0 conditions met/);
});
