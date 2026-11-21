// The workbench form's draft (rates typed in percent) and the chat's scenario proposals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftChange, draftFromChange, draftFromInputs, type WorkbenchInputs } from "../src/lib/research/valuation/workbench-draft";
import { scenarioProposalErrors, workbenchInputs, type WhatIfData } from "../src/lib/research/valuation/whatif";
import { buildScenarioStatements } from "../src/lib/research/valuation/engine";
import { buildFcffValuation, type ValuationSet } from "../src/lib/research/valuation/v2";
import { MockProvider } from "../src/lib/agent-harness/providers/mock";

function storedValuation(): WhatIfData {
  const ratios = { da_to_revenue: 0.05, capex_to_revenue: 0.06, tax_rate: 0.2 };
  const statements = (growth: number, margin: number) => buildScenarioStatements({ baseRevenue: 1000, baseYear: 2025, ratios,
    drivers: Array.from({ length: 5 }, (_, i) => ({ fiscal_year: 2026 + i, revenue_growth: growth, operating_margin: margin, nwc_to_revenue_change: 0.1 })) });
  const set = (key: ValuationSet["set"], discount_rate: number, terminal_growth = 0.025): ValuationSet => ({ set: key, discount_rate, terminal_growth, ronic: 0.2, fade_years: 5, rationale: "test" });
  const scenario_statements = { bear: statements(0.03, 0.2), base: statements(0.08, 0.25), bull: statements(0.12, 0.3) };
  const valuation_sets = [set("conservative", 0.1, 0.02), set("base", 0.09), set("aggressive", 0.08, 0.03)];
  const built = buildFcffValuation({ statements: scenario_statements, sets: valuation_sets,
    probabilities: { probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25 }, price: 40, currency: "USD",
    common: { bridge: 50, shares: 10, currency: "USD", sourceNotes: ["n"], bridgeExplanation: "Cash less debt." },
    timing: null, pack: null, fx: 1, capm: 0.09, riskFree: 0.04, historyRoic: 0.2 });
  return { valuation: { ...built.assembled.valuation_scenario_set, ...built.additions, scenario_statements, current_market_price: 40,
    risk_free_rate: { rate: 0.04 }, default_valuation_sets: valuation_sets, valuation_status: "complete" }, scenarios: null, analytics: null };
}

async function mockChat(packet: Record<string, unknown>) {
  let text = "";
  for await (const event of new MockProvider().stream({ model: "mock", agentName: "asset-analyst", prompt: JSON.stringify(packet) }, new AbortController().signal))
    if (event.type === "text.delta") text += event.text;
  return JSON.parse(text);
}

const inputs: WorkbenchInputs = {
  sets: [{ set: "conservative", discount_rate: 0.1012345, terminal_growth: 0.02, ronic: 0.2, fade_years: 5 },
    { set: "base", discount_rate: 0.09, terminal_growth: 0.025, ronic: 0.2, fade_years: 5 },
    { set: "aggressive", discount_rate: 0.08, terminal_growth: 0.03, ronic: 0.2, fade_years: 5 }],
  probabilities: { bear: 0.25, base: 0.5, bull: 0.25 },
  drivers: { bear: [{ fiscal_year: 2026, revenue_growth: 0.03, operating_margin: 0.2 }], base: [{ fiscal_year: 2026, revenue_growth: 0.08, operating_margin: 0.25 },
    { fiscal_year: 2027, revenue_growth: 0.08, operating_margin: 0.25 }], bull: [{ fiscal_year: 2026, revenue_growth: 0.12, operating_margin: 0.3 }] },
};

test("an untouched draft is no change, even where display rounds the stored value", () => {
  const draft = draftFromInputs(inputs);
  assert.equal(draft["set.conservative.discount_rate"], "10.12");
  assert.equal(draft["driver.base.2027.operating_margin"], "25");
  assert.deepEqual(draftChange(inputs, draft), { change: {}, error: null });
});

test("edits become a typed change holding only what differs", () => {
  const draft = { ...draftFromInputs(inputs), "set.base.discount_rate": "9.5", "set.base.fade_years": "7", "driver.base.2027.operating_margin": "22.5",
    "prob.bear": "20", "prob.bull": "30" };
  assert.deepEqual(draftChange(inputs, draft).change, {
    sets: { base: { discount_rate: 0.095, fade_years: 7 } },
    drivers: { base: [{ fiscal_year: 2027, operating_margin: 0.225 }] },
    probabilities: { bear: 0.2, base: 0.5, bull: 0.3 },
  });
  const bad = draftChange(inputs, { ...draft, "driver.bear.2026.revenue_growth": "abc" });
  assert.equal(bad.change, null);
  assert.match(bad.error!, /bear case's FY2026 revenue growth/);
});

test("a saved or proposed change loads back into the draft", () => {
  const change = { sets: { aggressive: { terminal_growth: 0.028 } }, drivers: { base: [{ fiscal_year: 2026, revenue_growth: 0.06 }] } };
  const draft = draftFromChange(inputs, change);
  assert.equal(draft["set.aggressive.terminal_growth"], "2.8");
  assert.equal(draft["driver.base.2026.revenue_growth"], "6");
  assert.deepEqual(draftChange(inputs, draft).change, change);
});

test("scenario proposals are refused, naming the proposal, when the run cannot be recomputed or names repeat", () => {
  const none: WhatIfData = { valuation: null, scenarios: null, analytics: null };
  const errors = scenarioProposalErrors([{ name: "Lower risk", rationale: "Rates fall.", change: {} }], none);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Lower risk: This run has no valuation/);
  const twice = scenarioProposalErrors([{ name: "A", rationale: "r", change: {} }, { name: "a", rationale: "r", change: {} }], none);
  assert.ok(twice.some((e) => /same name/.test(e)));
  assert.match(scenarioProposalErrors([{ rationale: "r", change: {} }], none)[0], /^Proposal 1: /);
});

test("the mock chat proposes one scenario that computes when the workbench is available, and none otherwise", async () => {
  const data = storedValuation();
  const answer = await mockChat({ output_contract: "research_chat", evidence: [{ id: "e1" }], workbench: { available: true, inputs: workbenchInputs(data) } });
  assert.equal(answer.scenario_proposals.length, 1);
  assert.deepEqual(scenarioProposalErrors(answer.scenario_proposals, data), []);
  assert.deepEqual(answer.proposals, []);
  const none = await mockChat({ output_contract: "research_chat", evidence: [], workbench: { available: false, reason: "No valuation." } });
  assert.deepEqual(none.scenario_proposals, []);
});
