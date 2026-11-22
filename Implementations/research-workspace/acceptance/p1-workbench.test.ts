// W-1 to W-3: the workbench engine, scenario proposals from the chat, and what a saved scenario keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScenarioStatements } from "../../../src/lib/research/valuation/engine";
import { buildFcffValuation, type ValuationSet } from "../../../src/lib/research/valuation/v2";
import { computeWhatIf, scenarioProposalErrors, scenarioSummary, whatIfAvailability, WhatIfError, type WhatIfData } from "../../../src/lib/research/valuation/whatif";

const ratios = { da_to_revenue: 0.05, capex_to_revenue: 0.06, tax_rate: 0.2 };
const statements = (growth: number, margin: number) => buildScenarioStatements({ baseRevenue: 1000, baseYear: 2025, ratios,
  drivers: Array.from({ length: 5 }, (_, i) => ({ fiscal_year: 2026 + i, revenue_growth: growth, operating_margin: margin, nwc_to_revenue_change: 0.1 })) });
const set = (key: ValuationSet["set"], discount_rate: number, terminal_growth = 0.025): ValuationSet => ({ set: key, discount_rate, terminal_growth, ronic: 0.2, fade_years: 5, rationale: "test" });
export function storedValuation(): WhatIfData {
  const scenario_statements = { bear: statements(0.03, 0.2), base: statements(0.08, 0.25), bull: statements(0.12, 0.3) };
  const valuation_sets = [set("conservative", 0.1, 0.02), set("base", 0.09), set("aggressive", 0.08, 0.03)];
  const built = buildFcffValuation({ statements: scenario_statements, sets: valuation_sets,
    probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }, price: 40, currency: "USD",
    common: { bridge: 50, shares: 10, currency: "USD", sourceNotes: ["n"], bridgeExplanation: "Cash less debt." },
    timing: null, pack: null, fx: 1, capm: 0.09, riskFree: 0.04, historyRoic: 0.2 });
  return { valuation: { ...built.assembled.valuation_scenario_set, ...built.additions, scenario_statements, current_market_price: 40,
    risk_free_rate: { rate: 0.04 }, default_valuation_sets: valuation_sets, valuation_status: "complete" }, scenarios: null, analytics: null };
}

test("W-1: no change reproduces the stored valuation; changes recompute; bad changes and unavailable runs say why", () => {
  const data = storedValuation();
  const base = computeWhatIf(data);
  assert.equal(base.value_today.base, Number(data.valuation!.value_today_base.toFixed(2)));
  assert.ok(computeWhatIf(data, { sets: { base: { discount_rate: 0.095 }, conservative: { discount_rate: 0.105 } } }).value_today.base! < base.value_today.base!);
  assert.throws(() => computeWhatIf(data, { sets: { base: { terminal_growth: 0.095 } } }), WhatIfError);
  assert.equal(whatIfAvailability({ valuation: null, scenarios: null, analytics: null }).available, false);
});

test("W-2: valid proposals pass; each problem names its proposal", () => {
  const data = storedValuation();
  const good = [{ name: "Margin squeeze", rationale: "Competition caps pricing.", change: { drivers: { base: [{ fiscal_year: 2027, operating_margin: 0.2 }] } } },
    { name: "Lower risk", rationale: "Rates fall.", change: { sets: { base: { discount_rate: 0.085 }, aggressive: { discount_rate: 0.08 } } } }];
  assert.deepEqual(scenarioProposalErrors(good, data), []);
  assert.deepEqual(scenarioProposalErrors([], data), []);
  const bad = scenarioProposalErrors([{ name: "Too much growth", rationale: "r", change: { sets: { base: { terminal_growth: 0.2 } } } }], data);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^Too much growth: /);
  assert.ok(scenarioProposalErrors("nope", data).length > 0);
  assert.ok(scenarioProposalErrors([...good, ...good], data).length > 0, "at most three");
  assert.ok(scenarioProposalErrors([{ ...good[0], values: [1] }], data).length > 0, "no extra fields");
  assert.ok(scenarioProposalErrors([{ ...good[0], name: "" }], data).length > 0);
});

test("W-3: a saved scenario keeps the values, returns, anchors and weights only", () => {
  const result = computeWhatIf(storedValuation(), { probabilities: { bear: 0.2, base: 0.5, bull: 0.3 } });
  const summary = scenarioSummary(result);
  assert.deepEqual(Object.keys(summary).sort(), ["anchors", "probabilities", "return_today", "value_today"]);
  assert.deepEqual(summary.value_today, result.value_today);
  assert.deepEqual(summary.probabilities, { bear: 0.2, base: 0.5, bull: 0.3 });
});
