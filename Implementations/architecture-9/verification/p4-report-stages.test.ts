import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { STAGE_HANDLERS } from "../../../src/lib/research/handlers";
import { dependentStages, readyStages } from "../../../src/lib/research/team-plan";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { DB, code, completed, ledger, read, runFixture } from "../acceptance/fixtures";

test("V-4.1: re-runs and gates treat the draft as part of the tail", () => {
  const reopened = dependentStages(["asset_valuation"]);
  assert.ok(reopened.includes("report_draft") && reopened.includes("ai_reviewer"));
  assert.ok(reopened.indexOf("report_draft") >= 0);
  const before = STAGE_CONFIGS.slice(0, 20).map(stage => stage.key);
  const ready = readyStages(ledger({ ...completed([...before, "report_draft"]), ai_reviewer: "waiting_for_human" }));
  assert.ok(!ready.includes("human_review"), "a review paused on a re-run decision does not open the final gate");
});

test("V-4.2 (AC-4.5): a revision request and a re-run pause handle both report stages", () => {
  assert.match(code("src/app/api/research-runs/[id]/review/route.ts"), /report_draft/);
  assert.match(code("src/lib/research/team.ts"), /report_draft/);
  assert.match(code("src/lib/workflow/orchestrator.ts"), /report_draft/);
});

test("V-4.3 (AC-4.2): draft calls are recorded under report_draft, the review under ai_reviewer", () => {
  // The mock run's own placement assertions are AC-4.6, in tests/sofi-research-e2e.test.ts.
  assert.equal(STAGE_HANDLERS.report_draft?.stageKey, "report_draft");
  const e2e = read("tests/sofi-research-e2e.test.ts");
  assert.match(e2e, /report_draft/);
  assert.match(e2e, /report_outline|report:outline/);
});

test("V-4.4 (AC-4.9): docs and the UI name the new stage", () => {
  assert.match(read("AGENTS.md"), /25 stages/);
  assert.doesNotMatch(read("AGENTS.md"), /24 stages/);
  assert.match(read("docs/architecture.md"), /report_draft/);
  assert.match(read("docs/system.md"), /report_draft/);
  assert.match(read("src/components/charts/PipelineProgressChart.tsx"), /report_draft/);
});

describe("report_draft migration", { skip: !DB }, () => {
  const fx = runFixture("reportstagesv");
  const { sql } = fx;
  const LEGACY = STAGE_CONFIGS.filter(stage => stage.key !== "report_draft").map(stage => stage.key);
  const migrate = async () => {
    for (const statement of read("drizzle/0018_report_draft_stage.sql").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean))
      await sql.unsafe(statement);
  };
  /** A 24-stage ledger as runs had before this change. */
  async function legacyRun(statuses: Record<string, string>) {
    const runId = await fx.newRun("running");
    for (const [i, key] of LEGACY.entries())
      await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status, max_retries, completion_criteria_json, validator_config_json)
        VALUES (${runId}, ${key}, ${i + 1}, ${statuses[key] ?? "pending"}, 2, '{}'::jsonb, '{}'::jsonb)`;
    return runId;
  }
  const rows = (runId: string) => sql`SELECT stage_key, stage_order, status FROM research_stages WHERE research_run_id = ${runId} ORDER BY stage_order`;

  before(() => fx.setup());
  after(() => fx.teardown());

  test("V-4.5 (AC-4.7): legacy ledgers gain report_draft with the right status, and a second run changes nothing", async () => {
    assert.equal(LEGACY.length, 24);
    const done = await legacyRun(Object.fromEntries(LEGACY.map(key => [key, "completed"])));
    const atGate = await legacyRun({ ...Object.fromEntries(LEGACY.slice(0, 21).map(key => [key, "completed"])), human_review: "waiting_for_human" });
    const midReview = await legacyRun({ ...Object.fromEntries(LEGACY.slice(0, 20).map(key => [key, "completed"])), ai_reviewer: "failed" });
    const early = await legacyRun(Object.fromEntries(LEGACY.slice(0, 6).map(key => [key, "completed"])));
    const backtestOnly = await legacyRun(Object.fromEntries(LEGACY.map(key =>
      [key, ["indicator_design", "strategy_design", "backtest_execution", "backtest_review"].includes(key) ? "completed" : "skipped"])));
    await migrate();
    await migrate();
    const expected: [string, string][] = [[done, "completed"], [atGate, "completed"], [midReview, "pending"], [early, "pending"], [backtestOnly, "skipped"]];
    for (const [runId, status] of expected) {
      const ledgerRows = await rows(runId);
      assert.equal(ledgerRows.length, 25);
      assert.deepEqual(ledgerRows.map(row => Number(row.stage_order)), Array.from({ length: 25 }, (_, i) => i + 1));
      assert.deepEqual(ledgerRows.map(row => row.stage_key), STAGE_CONFIGS.map(stage => stage.key));
      assert.equal(ledgerRows[20].status, status, `report_draft of run ${runId}`);
    }
    assert.equal((await rows(midReview))[21].status, "failed", "the review stage keeps its status");
    assert.equal((await rows(atGate))[22].status, "waiting_for_human");
  });
});
