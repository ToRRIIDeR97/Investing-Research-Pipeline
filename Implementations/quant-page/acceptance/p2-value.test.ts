// P2: AC-3..AC-6 PragValue parity with Pragma's Python on identical inputs, grades, routing and unavailable inputs.
// Golden files come from fixtures/pragma_parity.py running pulsevalue.py itself (see the script's header).
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../fixtures");
const cases = readdirSync(join(dir, "cases")).filter((f) => f.endsWith(".json"));
const near = (actual: number, expected: number, what: string) => {
  const tol = Math.max(Math.abs(expected) * 0.005, 0.011);
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs Pragma ${expected}`);
};

for (const file of cases) {
  test(`AC-4: parity with Pragma, ${file.replace(".json", "")}`, async () => {
    const { computePragValue } = await import("../../../src/lib/quant/value");
    const c = JSON.parse(readFileSync(join(dir, "cases", file), "utf8"));
    const g = JSON.parse(readFileSync(join(dir, "golden", file), "utf8"));
    const r = computePragValue(c.data, c.meta);
    assert.equal(r.engine, g.engine_used);
    assert.equal(r.confidence, g.confidence_score);
    near(r.pulse_score, g.pulse_score, "pulse_score");
    near(r.targets.bear, g.bear_target, "bear target");
    near(r.targets.base, g.base_target, "base target");
    near(r.targets.bull, g.bull_target, "bull target");
    assert.equal(r.v_deviation, g.v_deviation);
    assert.equal(r.pq_deviation, g.pq_deviation);
    assert.deepEqual(r.engine_result.quality_flags, g.quality_flags);
    assert.deepEqual(r.engine_result.structural_flags, g.structural_flags);
    near(r.engine_result.primary_value, g.primary_value, "primary value");
    near(r.engine_result.secondary_value, g.secondary_value, "secondary value");
    assert.equal(r.dcf.dcf_skipped, g.dcf.dcf_skipped);
    if (!g.dcf.dcf_skipped) {
      near(r.dcf.intrinsic_value_base, g.dcf.intrinsic_value_base, "dcf base");
      near(r.dcf.discount_rate, g.dcf.discount_rate, "discount rate");
      near(r.dcf.growth_rate_base, g.dcf.growth_rate_base, "base growth");
      near(r.dcf.growth_rate_bear, g.dcf.growth_rate_bear, "bear growth");
      assert.equal(r.dcf.operating_leverage_trend, g.dcf.operating_leverage_trend);
      assert.equal(r.dcf.exit_metric, g.dcf.exit_metric);
      assert.equal(r.dcf.price_targets.length, g.dcf.price_targets.length);
      r.dcf.price_targets.forEach((t, i) => {
        near(t.base_target, g.dcf.price_targets[i].base_target, `ladder year ${t.year} base`);
        near(t.bull_target, g.dcf.price_targets[i].bull_target, `ladder year ${t.year} bull`);
      });
    }
  });
}

test("AC-3: SIC sectors route to the right engine", async () => {
  const { sectorFromSic } = await import("../../../src/lib/quant/sic");
  const { routeEngine } = await import("../../../src/lib/quant/value/engines");
  const route = (sic: string, ebit: number | null, rev: number | null) => { const s = sectorFromSic(sic); return routeEngine(s.sector, s.industry, ebit, rev); };
  assert.equal(route("6022", 1e9, 5e9), "C");
  assert.equal(route("6798", 1e9, 5e9), "D");
  assert.equal(route("4911", 1e9, 5e9), "E");
  assert.equal(route("1311", 1e9, 5e9), "F");
  assert.equal(route("2836", -1e8, 1e6), "B2");
  assert.equal(route("6282", 1e9, 5e9), "G");
  assert.equal(route("7372", 1e9, 5e9), "A");
  assert.equal(route("7372", -1e8, 5e8), "B");
  assert.equal(route("9999", 1e9, 5e9), "A");
});

test("AC-5: grades use the shared band table and asymmetry", async () => {
  const { computePragValue } = await import("../../../src/lib/quant/value");
  const { gradeForDeviation } = await import("../../../src/lib/research/rating/grade");
  const c = JSON.parse(readFileSync(join(dir, "cases", "engine_a_software.json"), "utf8"));
  const r = computePragValue(c.data, c.meta);
  assert.equal(r.pulse_grade.grade, gradeForDeviation(r.adjusted_deviation));
  assert.ok(r.pulse_grade.label.length > 0 && r.pq_grade.label.length > 0);
});

test("AC-6: no credit series leaves the scalar at 1.0 and says so", async () => {
  const { computePragValue } = await import("../../../src/lib/quant/value");
  const c = JSON.parse(readFileSync(join(dir, "cases", "engine_a_software.json"), "utf8"));
  const r = computePragValue(c.data, c.meta);
  assert.equal(r.cis.status, "unavailable");
  assert.equal(r.cis.adjuster, 1);
  assert.equal(r.dcf.discount_rate, 0.1);
  assert.ok(r.notes.some((n) => /Credit Impact Scalar unavailable/.test(n)));
  const withCredit = computePragValue(c.data, { ...c.meta, creditZ: 1.5 });
  assert.equal(withCredit.cis.status, "computed");
  assert.ok(withCredit.dcf.discount_rate > 0.1, "wider spreads raise the discount rate");
});
