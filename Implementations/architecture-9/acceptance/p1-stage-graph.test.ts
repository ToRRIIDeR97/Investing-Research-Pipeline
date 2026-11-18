import assert from "node:assert/strict";
import test from "node:test";
import { STAGE_DEPENDENCIES, dependentStages, readyStages } from "../../../src/lib/research/team-plan";
import { code, completed, ledger } from "./fixtures";

const BACKTEST = ["indicator_design", "strategy_design", "backtest_execution", "backtest_review"];
const BEFORE_GATE = ["intake", "asset_identity", "archetype_composition"];

test("AC-1.1: the backtest chain hangs off the approved plan, and the decision still waits for both branches", () => {
  assert.deepEqual(STAGE_DEPENDENCIES.indicator_design, ["research_plan"]);
  assert.deepEqual(STAGE_DEPENDENCIES.strategy_design, ["indicator_design"]);
  assert.deepEqual(STAGE_DEPENDENCIES.backtest_execution, ["strategy_design"]);
  assert.deepEqual(STAGE_DEPENDENCIES.backtest_review, ["backtest_execution"]);
  assert.deepEqual([...STAGE_DEPENDENCIES.decision_synthesis].sort(), ["asset_valuation", "backtest_review"]);
});

test("AC-1.2: plan approval starts source discovery and indicator design together", () => {
  const ready = readyStages(ledger(completed([...BEFORE_GATE, "research_plan"])));
  assert.deepEqual([...ready].sort(), ["indicator_design", "source_discovery"]);
});

test("AC-1.2: nothing past the plan gate is ready while the gate waits", () => {
  const ready = readyStages(ledger({ ...completed(BEFORE_GATE), research_plan: "waiting_for_human" }));
  assert.ok(!ready.includes("indicator_design"));
  assert.ok(!ready.includes("source_discovery"));
});

test("AC-1.2: a quick scan, which skips the backtests, starts only source discovery", () => {
  assert.deepEqual(readyStages(ledger(completed([...BEFORE_GATE, "research_plan"]), "quick_scan")), ["source_discovery"]);
});

test("AC-1.3: a valuation re-run reopens the decision but not the backtests", () => {
  const reopened = dependentStages(["asset_valuation"]);
  for (const key of BACKTEST) assert.ok(!reopened.includes(key), `${key} must not reopen`);
  assert.ok(reopened.includes("decision_synthesis"));
});

test("AC-1.4: the runner's pass limit is a named constant", () => {
  const source = code("src/lib/research/pipeline-runner.ts");
  assert.match(source, /export const MAX_SCHEDULING_PASSES\s*=\s*\d/);
  assert.doesNotMatch(source, /\b19[12]\b/);
});
