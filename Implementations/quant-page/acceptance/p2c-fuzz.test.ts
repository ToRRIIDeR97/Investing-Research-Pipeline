// P2 (added in review, AC-4): 400 seeded mutations of the parity fixtures, each checked against Pragma's own
// PulseValue result (fixtures/pragma_fuzz.py). Covers what the eight fixtures do not: credit z, short histories,
// nulls and negatives, quarterly margins, forward EPS, the single-metric fallback and weighted-median ties.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../fixtures");
const fuzz = JSON.parse(readFileSync(join(dir, "fuzz.json"), "utf8")) as any[];
const histories = new Map<string, unknown>();
const historyOf = (base: string) => {
  if (!histories.has(base)) histories.set(base, JSON.parse(readFileSync(join(dir, "cases", `${base}.json`), "utf8")).data.history);
  return histories.get(base);
};
const near = (a: number, e: number) => Math.abs(a - e) <= Math.max(Math.abs(e) * 0.005, 0.011);

test("AC-4: every fuzz case matches Pragma (engine, confidence, PulseScore, targets, grades, flags, discount rate, exit metric)", async () => {
  const { computePragValue } = await import("../../../src/lib/quant/value");
  assert.ok(fuzz.length >= 400);
  const mismatches: string[] = [];
  fuzz.forEach((c, i) => {
    if (c.error) return;
    const r = computePragValue({ ...c.data, history: historyOf(c.base) }, { ...c.meta, creditZ: c.credit_z });
    const g = c.gold;
    const checks: [string, boolean][] = [
      ["engine", r.engine === g.engine_used], ["confidence", r.confidence === g.confidence_score],
      ["pulse", near(r.pulse_score, g.pulse_score)], ["bear", near(r.targets.bear, g.bear_target)],
      ["base", near(r.targets.base, g.base_target)], ["bull", near(r.targets.bull, g.bull_target)],
      ["v_dev", r.v_deviation === g.v_deviation], ["pq_dev", r.pq_deviation === g.pq_deviation],
      ["quality_flags", JSON.stringify(r.engine_result.quality_flags) === JSON.stringify(g.quality_flags)],
      ["structural_flags", JSON.stringify(r.engine_result.structural_flags) === JSON.stringify(g.structural_flags)],
      ["dcf_skipped", r.dcf.dcf_skipped === g.dcf.dcf_skipped],
      ["discount", near(r.dcf.discount_rate, g.dcf.discount_rate)], ["exit_metric", r.dcf.exit_metric === g.dcf.exit_metric],
    ];
    const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
    if (bad.length) mismatches.push(`#${i} (${c.base}, ${c.meta.industry}): ${bad.join(", ")}`);
  });
  assert.deepEqual(mismatches, []);
});

test("AC-4: the weighted median uses Python's compensated sum at the 0.5 boundary", async () => {
  const { pySum } = await import("../../../src/lib/quant/value/model");
  assert.equal(pySum([0.3, 0.2, 0.05, 0.15]), 0.7);
  assert.equal(pySum([0.1, 0.2, 0.3]), 0.6);
});
