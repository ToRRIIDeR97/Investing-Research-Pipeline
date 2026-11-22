// The valuation workbench's engine: a stored v2 valuation recomputed in code under typed changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScenarioStatements } from "../src/lib/research/valuation/engine";
import { buildFcffValuation, type ValuationSet } from "../src/lib/research/valuation/v2";
import { computeWhatIf, editStatements, whatIfAvailability, workbenchInputs, WhatIfError, type WhatIfData } from "../src/lib/research/valuation/whatif";

const ratios = { da_to_revenue: 0.05, capex_to_revenue: 0.06, tax_rate: 0.2 };
const statements = (growth: number, margin: number) => buildScenarioStatements({ baseRevenue: 1000, baseYear: 2025, ratios,
  drivers: Array.from({ length: 5 }, (_, i) => ({ fiscal_year: 2026 + i, revenue_growth: growth, operating_margin: margin, nwc_to_revenue_change: 0.1 })) });
const set = (key: ValuationSet["set"], discount_rate: number, terminal_growth = 0.025): ValuationSet => ({ set: key, discount_rate, terminal_growth, ronic: 0.2, fade_years: 5, rationale: "test" });

function stored(): WhatIfData {
  const scenario_statements = { bear: statements(0.03, 0.2), base: statements(0.08, 0.25), bull: statements(0.12, 0.3) };
  const valuation_sets = [set("conservative", 0.1, 0.02), set("base", 0.09), set("aggressive", 0.08, 0.03)];
  const built = buildFcffValuation({ statements: scenario_statements, sets: valuation_sets,
    probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }, price: 40, currency: "USD",
    common: { bridge: 50, shares: 10, currency: "USD", sourceNotes: ["n"], bridgeExplanation: "Cash less debt." },
    timing: null, pack: null, fx: 1, capm: 0.09, riskFree: 0.04, historyRoic: 0.2 });
  return { valuation: { ...built.assembled.valuation_scenario_set, ...built.additions, scenario_statements, current_market_price: 40,
    risk_free_rate: { rate: 0.04 }, default_valuation_sets: valuation_sets, valuation_status: "complete" }, scenarios: null, analytics: null };
}

test("with no change the workbench reproduces the stored valuation", () => {
  const data = stored();
  const result = computeWhatIf(data);
  const v = data.valuation!;
  assert.equal(result.value_today.base, Number(v.value_today_base.toFixed(2)));
  assert.equal(result.value_today.weighted, Number(v.weighted_value_today.toFixed(2)));
  assert.equal(result.anchors.base, Number(v.terminal_anchor_base.toFixed(2)));
  assert.equal(result.matrix.rows.length, 9);
  assert.deepEqual(workbenchInputs(data).probabilities, { bear: 0.25, base: 0.5, bull: 0.25 });
});

test("a higher discount rate lowers value; probabilities reweight it", () => {
  const data = stored();
  const before = computeWhatIf(data);
  const after = computeWhatIf(data, { sets: { base: { discount_rate: 0.095 }, conservative: { discount_rate: 0.105 } } });
  assert.ok(after.value_today.base! < before.value_today.base!);
  const bullish = computeWhatIf(data, { probabilities: { bear: 0.1, base: 0.4, bull: 0.5 } });
  assert.ok(bullish.value_today.weighted! > before.value_today.weighted!);
  assert.equal(bullish.value_today.base, before.value_today.base, "weights do not change a case's value");
});

test("changes that break a valuation rule are refused with a reader-facing reason", () => {
  const data = stored();
  assert.throws(() => computeWhatIf(data, { sets: { base: { terminal_growth: 0.095 } } }), (e: unknown) => e instanceof WhatIfError && /terminal_growth|growth/.test((e as Error).message));
  assert.throws(() => computeWhatIf(data, { sets: { base: { discount_rate: 0.03 } } }), WhatIfError, "below the risk-free rate");
  assert.throws(() => computeWhatIf(data, { probabilities: { bear: 0.5, base: 0.5, bull: 0.5 } }), /100%/);
  assert.throws(() => computeWhatIf(data, { drivers: { base: [{ fiscal_year: 2040, revenue_growth: 0.1 }] } }), /outside the forecast/);
  assert.throws(() => computeWhatIf(data, { values: [1] } as never), WhatIfError);
});

test("driver edits re-derive the case from the edited year on, holding the stored ratios", () => {
  const base = statements(0.08, 0.25);
  assert.deepEqual(editStatements(base, []), base, "no edit, no change");
  const edited = editStatements(base, [{ fiscal_year: 2028, revenue_growth: 0.2 }]);
  assert.deepEqual(edited.slice(0, 2), base.slice(0, 2), "years before the edit are untouched");
  assert.ok(Math.abs(edited[2].revenue - base[1].revenue * 1.2) < 1e-6);
  assert.ok(edited[3].revenue > base[3].revenue, "later years grow from the new base");
  assert.ok(Math.abs(edited[2].capital_expenditures / edited[2].revenue - base[2].capital_expenditures / base[2].revenue) < 1e-9, "capex keeps its share of revenue");
  const y = edited[3];
  assert.ok(Math.abs(y.fcff - (y.nopat + y.depreciation_amortization - y.capital_expenditures - y.change_in_net_working_capital)) < 1e-9);
  const data = stored();
  const higher = computeWhatIf(data, { drivers: { base: [{ fiscal_year: 2027, operating_margin: 0.35 }] } });
  assert.ok(higher.value_today.base! > computeWhatIf(data).value_today.base!);
  assert.equal(higher.drivers.base[1].operating_margin, 0.35);
});

test("runs the workbench cannot recompute say why", () => {
  assert.equal(whatIfAvailability({ valuation: null, scenarios: null, analytics: null }).available, false);
  const withheld = { valuation: { valuation_status: "withheld", withheld_reason: "No stored close.", terminal_anchor_bear: 0, terminal_anchor_base: 0, terminal_anchor_bull: 0 }, scenarios: null, analytics: null };
  assert.match((whatIfAvailability(withheld) as { reason: string }).reason, /No stored close/);
  const bank = { valuation: { engine_version: undefined, method_inputs: [] }, scenarios: null, analytics: null };
  assert.match((whatIfAvailability(bank) as { reason: string }).reason, /model-built|older engine/);
  assert.throws(() => computeWhatIf(bank), WhatIfError);
});
