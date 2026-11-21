// Independent checks for P1 (W-1 to W-3): different edits and boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWhatIf, scenarioProposalErrors, scenarioSummary, workbenchInputs } from "../../../src/lib/research/valuation/whatif";
import { storedValuation } from "../acceptance/p1-workbench.test";

test("V-W1: an edit to the last forecast year moves only that year and the terminal", () => {
  const data = storedValuation();
  const before = computeWhatIf(data), after = computeWhatIf(data, { drivers: { bull: [{ fiscal_year: 2030, revenue_growth: 0.2 }] } });
  assert.deepEqual(after.drivers.bull.slice(0, 4), before.drivers.bull.slice(0, 4));
  assert.ok(after.value_today.bull! > before.value_today.bull!);
  assert.equal(after.value_today.bear, before.value_today.bear);
});

test("V-W1: inputs do not mutate the stored valuation", () => {
  const data = storedValuation();
  const snapshot = JSON.stringify(data);
  computeWhatIf(data, { sets: { aggressive: { ronic: 0.3 } }, drivers: { base: [{ fiscal_year: 2026, operating_margin: 0.3 }] } });
  assert.equal(JSON.stringify(data), snapshot);
  assert.equal(workbenchInputs(data).drivers.base.length, 5);
});

test("V-W2: a proposal must compute; ordering rules across sets count", () => {
  const data = storedValuation();
  assert.ok(scenarioProposalErrors([{ name: "Inverted", rationale: "r", change: { sets: { conservative: { discount_rate: 0.07 } } } }], data).length > 0, "conservative rate below base");
  assert.ok(scenarioProposalErrors([{ name: "x".repeat(81), rationale: "r", change: {} }], data).length > 0);
  assert.deepEqual(scenarioProposalErrors([{ name: "Same", rationale: "No change at all.", change: {} }], data), []);
});

test("V-W3: the summary is plain data", () => {
  const summary = scenarioSummary(computeWhatIf(storedValuation()));
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  assert.ok(Object.values(summary.value_today).every((v) => v === null || typeof v === "number"));
});
