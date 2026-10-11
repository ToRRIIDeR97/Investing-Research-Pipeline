import assert from "node:assert/strict";
import { test } from "node:test";
import { reinvestmentNotes } from "@/lib/research/handlers/operating-scenarios";

test("a sourced capex forecast is stated as copied, never called a zero placeholder", () => {
  const notes = reinvestmentNotes({ capex_forecast: [115000], working_capital_forecast: [], units: "USD millions" });
  for (const text of [notes.baseReinvestment, notes.scenarioReinvestment]) {
    assert.match(text, /115000 USD millions/);
    assert.doesNotMatch(text, /placeholder/);
  }
  // No working-capital forecast: the model's text is kept and the gap is recorded.
  assert.equal(notes.baseWorkingCapital, null);
  assert.equal(notes.sourceGaps.length, 1);
});

test("the zero-capex placeholder sentences appear only without a capex forecast", () => {
  for (const capex of [[], [0, 0]]) {
    const notes = reinvestmentNotes({ capex_forecast: capex, working_capital_forecast: [-120, -130] });
    assert.match(notes.baseReinvestment, /zero capex is a disclosed missing-data placeholder/);
    assert.match(notes.scenarioReinvestment, /unsourced zero placeholder/);
    assert.equal(notes.baseWorkingCapital, "Base funding-surplus proxy from reinvestment_model: -120, -130 USD millions.");
    assert.deepEqual(notes.sourceGaps, []);
  }
});
