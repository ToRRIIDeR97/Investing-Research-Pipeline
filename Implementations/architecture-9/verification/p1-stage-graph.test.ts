import assert from "node:assert/strict";
import test from "node:test";
import * as runner from "../../../src/lib/research/pipeline-runner";
import { dependentStages, readyStages } from "../../../src/lib/research/team-plan";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { completed, ledger } from "../acceptance/fixtures";

const BACKTEST = ["indicator_design", "strategy_design", "backtest_execution", "backtest_review"];
const through = (key: string) => STAGE_CONFIGS.slice(0, STAGE_CONFIGS.findIndex(stage => stage.key === key) + 1).map(stage => stage.key);

test("V-1.1: a backtest-only run starts at indicator design and walks the chain", () => {
  assert.deepEqual(readyStages(ledger({}, "backtest_only")), ["indicator_design"]);
  assert.deepEqual(readyStages(ledger(completed(["indicator_design", "strategy_design"]), "backtest_only")), ["backtest_execution"]);
});

test("V-1.2: the two branches advance independently after the gate", () => {
  const ready = readyStages(ledger({ ...completed(through("research_plan")), indicator_design: "completed", source_discovery: "running" }));
  assert.deepEqual([...ready].sort(), ["source_discovery", "strategy_design"]);
});

test("V-1.3: the decision waits for whichever branch finishes last", () => {
  const analysis = through("asset_valuation").filter(key => !BACKTEST.includes(key));
  assert.ok(!readyStages(ledger(completed(analysis))).includes("decision_synthesis"), "backtests unfinished");
  const backtestsOnly = [...through("research_plan"), ...BACKTEST];
  assert.ok(!readyStages(ledger(completed(backtestsOnly))).includes("decision_synthesis"), "valuation unfinished");
  assert.ok(readyStages(ledger(completed([...analysis, ...BACKTEST]))).includes("decision_synthesis"));
});

test("V-1.4: a withheld backtest (review skipped) does not block the decision", () => {
  const analysis = through("asset_valuation").filter(key => !BACKTEST.includes(key));
  const ready = readyStages(ledger({ ...completed([...analysis, "indicator_design", "strategy_design", "backtest_execution"]), backtest_review: "skipped" }));
  assert.ok(ready.includes("decision_synthesis"));
});

test("V-1.5: re-runs reach the right stages", () => {
  const history = dependentStages(["historical_record"]);
  for (const key of BACKTEST) assert.ok(!history.includes(key), `${key} must not reopen with historical_record`);
  assert.ok(history.includes("asset_valuation"));
  const backtest = dependentStages(["indicator_design"]);
  assert.ok(backtest.includes("backtest_review") && backtest.includes("decision_synthesis"));
  assert.ok(!backtest.includes("asset_valuation"));
  assert.ok(dependentStages(["research_plan"]).includes("indicator_design"));
});

test("V-1.6: the pass limit is exported and large enough for every stage with retries", () => {
  const limit = (runner as unknown as { MAX_SCHEDULING_PASSES: number }).MAX_SCHEDULING_PASSES;
  assert.equal(typeof limit, "number");
  assert.ok(limit >= STAGE_CONFIGS.length * 4, "below the current budget of 192 passes for 24 stages would cut runs short");
});
