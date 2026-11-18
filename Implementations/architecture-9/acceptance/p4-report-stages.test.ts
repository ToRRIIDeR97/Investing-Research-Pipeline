import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { STAGE_HANDLERS } from "../../../src/lib/research/handlers";
import { REQUEST_TAIL_STAGES } from "../../../src/lib/research/team";
import { STAGE_DEPENDENCIES, STAGE_OWNERS, readyStages } from "../../../src/lib/research/team-plan";
import { createStagesForRun } from "../../../src/lib/workflow/orchestrator";
import { STAGE_CONFIGS, getStageConfig } from "../../../src/lib/workflow/stages";
import { DB, completed, ledger, runFixture } from "./fixtures";

test("AC-4.1: 25 stages, with report_draft before ai_reviewer", () => {
  assert.equal(STAGE_CONFIGS.length, 25);
  assert.deepEqual(STAGE_CONFIGS.map(stage => stage.order), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.deepEqual(STAGE_CONFIGS.slice(19).map(stage => stage.key),
    ["decision_synthesis", "report_draft", "ai_reviewer", "human_review", "export", "refresh_schedule"]);
  const draft = getStageConfig("report_draft")!;
  assert.equal(draft.failureState, "fail_run");
  assert.equal(draft.maxRetries, 2);
  assert.equal(draft.requiresHumanApproval, false);
  assert.ok(draft.skipForRunTypes.includes("backtest_only"));
});

test("AC-4.1: dependencies, owner, handler and tail membership", () => {
  assert.deepEqual(STAGE_DEPENDENCIES.report_draft, ["decision_synthesis"]);
  assert.deepEqual(STAGE_DEPENDENCIES.ai_reviewer, ["report_draft"]);
  assert.deepEqual(STAGE_DEPENDENCIES.human_review, ["ai_reviewer"]);
  assert.equal(STAGE_OWNERS.report_draft, "report");
  assert.equal(STAGE_HANDLERS.report_draft?.stageKey, "report_draft");
  assert.equal(STAGE_HANDLERS.ai_reviewer?.stageKey, "ai_reviewer");
  assert.ok(REQUEST_TAIL_STAGES.includes("report_draft"));
});

test("AC-4.1: the review cannot start before the draft is done", () => {
  const before = STAGE_CONFIGS.slice(0, 20).map(stage => stage.key);
  assert.deepEqual(readyStages(ledger(completed(before))), ["report_draft"]);
  assert.deepEqual(readyStages(ledger(completed([...before, "report_draft"]))), ["ai_reviewer"]);
});

describe("report stage ledger", { skip: !DB }, () => {
  const fx = runFixture("reportstages");
  before(() => fx.setup());
  after(() => fx.teardown());

  test("AC-4.1: a new run gets 25 stage rows with report_draft at order 21", async () => {
    const runId = await fx.newRun();
    await createStagesForRun(runId);
    const rows = await fx.sql`SELECT stage_key, stage_order, status, max_retries FROM research_stages WHERE research_run_id = ${runId} ORDER BY stage_order`;
    assert.equal(rows.length, 25);
    assert.deepEqual(rows.slice(20).map(row => [row.stage_key, Number(row.stage_order)]),
      [["report_draft", 21], ["ai_reviewer", 22], ["human_review", 23], ["export", 24], ["refresh_schedule", 25]]);
    assert.equal(rows[20].status, "pending");
    assert.equal(Number(rows[20].max_retries), 2);
  });

  test("AC-4.1: a backtest-only run skips report_draft", async () => {
    const runId = await fx.newRun("pending", {}, "backtest_only");
    await createStagesForRun(runId);
    const [row] = await fx.sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'report_draft'`;
    assert.equal(row.status, "skipped");
  });
});
