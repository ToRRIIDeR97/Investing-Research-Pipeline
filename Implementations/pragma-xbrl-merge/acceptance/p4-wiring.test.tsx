// P4: AC-13..AC-16 the stock_rating artifact, its checklist measures, its panel and its writer.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ramp, read, series } from "./support";

const build = () => import("../../../src/lib/research/rating/build");
const valuation = {
  valuation_status: "complete", current_market_price: 100,
  value_today_bear: 80, value_today_base: 125, value_today_bull: 160,
  sanity: { flags: [{ flag: "terminal_share" }] },
};
const priceHistory = { valuation_price: { verified: true }, beta: { verified: true } };
const up = series(ramp(300, 50, 150));
const bench = series(Array(300).fill(100));

test("AC-13: a valued run is rated", async () => {
  const { buildStockRating } = await build();
  const r = buildStockRating({ valuation, priceHistory, stockCloses: up, benchmarkCloses: bench, yearsCaptured: 5 });
  assert.equal(r.artifact_type, "stock_rating");
  assert.equal(r.status, "rated");
  assert.equal(r.price, 100);
  assert.deepEqual(r.value_today, { bear: 80, base: 125, bull: 160 });
  assert.equal(r.data_quality, "High");
  assert.equal(r.confidence, 90);
  assert.equal(r.raw_deviation, -0.2);
  assert.equal(r.adjusted_deviation, -0.1897);
  assert.equal(r.valuation_grade, "A-");
  assert.equal(r.valuation_label, "Moderate discount");
  assert.equal(r.composite_deviation, -0.1794);
  assert.equal(r.composite_grade, "A-");
  assert.equal(r.macro.credit_z, null);
  assert.equal(r.macro.status, "unavailable");
  assert.equal(r.trend.score_label, "9/9 conditions met");
  assert.ok(r.method.length > 0);
});

test("AC-13: a withheld valuation gives a withheld rating with the trend kept", async () => {
  const { buildStockRating } = await build();
  const r = buildStockRating({ valuation: { ...valuation, valuation_status: "withheld" }, priceHistory, stockCloses: up, benchmarkCloses: bench, yearsCaptured: 5 });
  assert.equal(r.status, "withheld");
  assert.ok(r.withheld_reason);
  assert.equal(r.valuation_grade, null);
  assert.equal(r.composite_grade, null);
  assert.equal(r.confidence, null);
  assert.equal(r.trend.passed, 9);
});

test("AC-13: closes are restated on the latest split basis", async () => {
  const { splitAdjustedCloses } = await build();
  const out = splitAdjustedCloses([
    { day: "2024-01-02", close: 200, retrieved_day: "2024-01-02" },
    { day: "2024-01-03", close: 100, retrieved_day: "2024-01-03" },
  ] as any, [{ ex_day: "2024-01-03", ratio: 2 }]);
  assert.deepEqual(out, [{ day: "2024-01-02", close: 100 }, { day: "2024-01-03", close: 100 }]);
});

test("AC-14: checklist measures read the rating", async () => {
  const { buildStockRating } = await build();
  const { measureValue, MEASURE_KEYS } = await import("../../../src/lib/research/checklist/measures");
  assert.ok((MEASURE_KEYS as readonly string[]).includes("trend_score_pct"));
  assert.ok((MEASURE_KEYS as readonly string[]).includes("valuation_deviation_pct"));
  const rating = buildStockRating({ valuation, priceHistory, stockCloses: up, benchmarkCloses: bench, yearsCaptured: 5 });
  const artifacts = [{ artifact_type: "stock_rating", artifact_version: 1, content_json: rating }];
  assert.deepEqual(measureValue("trend_score_pct" as any, artifacts), { value: 100, display: "100.0%" });
  assert.deepEqual(measureValue("valuation_deviation_pct" as any, artifacts), { value: -18.97, display: "-19.0%" });
  const none = measureValue("trend_score_pct" as any, []);
  assert.equal(none.value, null);
});

test("AC-15: the panel shows a rated run", async () => {
  const { buildStockRating } = await build();
  const { StockRatingPanel } = await import("../../../src/components/report/stock-rating");
  const rating = buildStockRating({ valuation, priceHistory, stockCloses: up, benchmarkCloses: bench, yearsCaptured: 5 });
  const html = renderToStaticMarkup(<StockRatingPanel artifacts={[{ artifact_type: "stock_rating", content_json: rating }]} />);
  assert.match(html, /A-/);
  assert.match(html, /Moderate discount/);
  assert.match(html, /90/);
  assert.match(html, /9\/9 conditions met/);
  assert.equal(renderToStaticMarkup(<StockRatingPanel artifacts={[]} />), "");
});

test("AC-15: the panel shows why a rating is withheld", async () => {
  const { buildStockRating } = await build();
  const { StockRatingPanel } = await import("../../../src/components/report/stock-rating");
  const rating = buildStockRating({ valuation: null, priceHistory, stockCloses: up, benchmarkCloses: bench, yearsCaptured: 5 });
  const html = renderToStaticMarkup(<StockRatingPanel artifacts={[{ artifact_type: "stock_rating", content_json: rating }]} />);
  assert.match(html, /withheld/i);
  assert.match(html, /9\/9 conditions met/);
});

test("AC-16: decision synthesis writes stock_rating and the type is registered", async () => {
  const { artifactTypes } = await import("../../../src/lib/research/artifacts/contracts");
  assert.equal((artifactTypes as Record<string, string>).stock_rating, "stock_rating");
  const handler = read("src/lib/research/handlers/decision-synthesis.ts");
  assert.match(handler, /buildStockRating\(/);
  assert.match(handler, /artifact_type: "stock_rating"/);
  assert.match(read("src/components/report/valuation-summary.tsx"), /<StockRatingPanel/);
  assert.match(read("src/lib/api/checklists.ts"), /'stock_rating'/);
});
