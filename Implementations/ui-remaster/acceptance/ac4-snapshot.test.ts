// AC-4: the key numbers every asset page and card leads with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assetSnapshot } from "../../../src/lib/research/asset-snapshot";
import { monitoring, pricePath, reportFacts, valuationSet } from "../fixtures/artifacts";

test("AC-4: SoFi's price, case values, gaps, targets and KPI tones", () => {
  const s = assetSnapshot([reportFacts(), valuationSet(false), pricePath, monitoring]);
  assert.ok(s);
  assert.equal(s.currency, "USD");
  assert.equal(s.price, 14.28);
  assert.equal(s.price_verified, false);
  assert.deepEqual(s.values, { bear: -1.79, base: 1.13, bull: 6.74 });
  assert.equal(s.weighted, 1.38);
  assert.equal(Math.round(s.gap.base! * 100), -92);
  assert.equal(Math.round(s.gap.bull! * 100), -53);
  assert.deepEqual(s.targets, [{ year: 2026, bear: -2.1, base: 0.15, bull: 3.34 }, { year: 2027, bear: -1.5, base: 0.76, bull: 4.9 }]);
  assert.deepEqual(s.kpis.map((k) => [k.label, k.tone]), [
    ["Capital headroom", "good"], ["Share count and dilution", "good"], ["Card net charge-offs", "bad"], ["Net charge-off ratio", "neutral"],
  ]);
  assert.equal(s.kpis[0].display, "16.9%");
});

test("AC-4: no valuation artifacts gives null; a withheld valuation keeps price but not values", () => {
  assert.equal(assetSnapshot([monitoring]), null);
  const s = assetSnapshot([reportFacts({ valuation_status: "withheld" }), pricePath]);
  assert.ok(s);
  assert.equal(s.price, 14.28);
  assert.deepEqual(s.values, { bear: null, base: null, bull: null });
  assert.equal(s.weighted, null);
  assert.equal(s.gap.base, null);
  assert.equal(s.targets.length, 2);
});
