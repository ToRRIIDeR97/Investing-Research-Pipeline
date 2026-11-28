import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { ResearchAgentRunError } from "../../../src/lib/agent-harness/errors";
import { STAGE_HANDLERS } from "../../../src/lib/research/handlers";
import { runResearchPipeline } from "../../../src/lib/research/pipeline-runner";
import { createStagesForRun, requestResearchPlanChanges } from "../../../src/lib/workflow/orchestrator";
import { DB, read, runFixture } from "../acceptance/fixtures";

describe("run-control migration and boundaries", { skip: !DB }, () => {
  const fx = runFixture("runcontrolv");
  const { sql } = fx;
  const intake = STAGE_HANDLERS.intake;
  const migrate = async () => {
    for (const statement of read("drizzle/0017_run_control_state.sql").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean))
      await sql.unsafe(statement);
  };

  before(async () => { process.env.RESEARCH_STAGE_RETRY_DELAY_MS = "1"; await fx.setup(); });
  after(async () => { STAGE_HANDLERS.intake = intake; await fx.teardown(); });

  test("V-3.1 (AC-3.6): the migration backfills old JSON state and is safe to run twice", async () => {
    const at = "2026-10-20T10:00:00.000Z";
    const pending = await fx.newRun("waiting_for_human", {
      request_reset: { stages: ["asset_valuation", "decision_synthesis"], request_ids: ["r1"], estimated_cost_usd: 1.5 },
      request_auto_reset: { stages: ["moat_analysis"], request_ids: ["r0"], round: 2, at },
      research_plan_feedback: [{ notes: "first", requested_by: "a", requested_at: "2026-10-19T10:00:00.000Z" },
        { notes: "second", requested_by: "b", requested_at: "2026-10-19T11:00:00.000Z" }],
    });
    const decided = await fx.newRun("running", {
      request_reset_decision: { decision: "skip", actor: "reviewer", stages: ["operating_model"], request_ids: ["r9"], decided_at: at },
    });
    const clean = await fx.newRun("running");
    for (const runId of [pending, decided, clean]) await createStagesForRun(runId);
    await sql`UPDATE research_stages SET validation_result_json = ${sql.json({ transient_failures: 2, last_transient_error: "Provider HTTP 529" })}
      WHERE research_run_id = ${pending} AND stage_key = 'moat_analysis'`;
    // Rows the application would have written are absent: these runs carry only the old JSON.
    await migrate();
    await migrate();

    const resets = await sql`SELECT kind, status, stages, request_ids, round, estimated_cost_usd, decided_by FROM research_run_resets
      WHERE research_run_id = ${pending} ORDER BY kind`;
    assert.equal(resets.length, 2, "one approval and one auto row, not duplicated by the second run");
    const [approval, auto] = [resets.find(r => r.kind === "approval")!, resets.find(r => r.kind === "auto")!];
    assert.equal(approval.status, "pending");
    assert.deepEqual(approval.stages, ["asset_valuation", "decision_synthesis"]);
    assert.deepEqual(approval.request_ids, ["r1"]);
    assert.equal(Number(approval.estimated_cost_usd), 1.5);
    assert.equal(auto.status, "applied");
    assert.deepEqual(auto.stages, ["moat_analysis"]);
    assert.equal(Number(auto.round), 2);

    const [skipped] = await sql`SELECT kind, status, decided_by, stages FROM research_run_resets WHERE research_run_id = ${decided}`;
    assert.deepEqual([skipped.kind, skipped.status, skipped.decided_by], ["approval", "skipped", "reviewer"]);
    assert.deepEqual(skipped.stages, ["operating_model"]);

    const notes = await sql`SELECT notes, requested_by FROM research_plan_feedback WHERE research_run_id = ${pending} ORDER BY requested_at`;
    assert.deepEqual(notes.map(n => [n.notes, n.requested_by]), [["first", "a"], ["second", "b"]]);
    const [stage] = await sql`SELECT transient_failures, last_transient_error FROM research_stages WHERE research_run_id = ${pending} AND stage_key = 'moat_analysis'`;
    assert.equal(Number(stage.transient_failures), 2);
    assert.match(String(stage.last_transient_error), /529/);

    assert.equal((await sql`SELECT 1 FROM research_run_resets WHERE research_run_id = ${clean}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM research_plan_feedback WHERE research_run_id = ${clean}`).length, 0);
  });

  test("V-3.2: at most one pending re-run per run", async () => {
    const runId = await fx.newRun("waiting_for_human");
    const insert = () => sql`INSERT INTO research_run_resets (research_run_id, kind, status, stages, request_ids)
      VALUES (${runId}, 'approval', 'pending', ${["asset_valuation"]}, ${["r1"]})`;
    await insert();
    await assert.rejects(insert());
    await sql`INSERT INTO research_run_resets (research_run_id, kind, status, stages, request_ids) VALUES (${runId}, 'auto', 'applied', ${["moat_analysis"]}, ${["r2"]})`;
  });

  test("V-3.3: feedback is refused when the plan is not waiting, and writes nothing", async () => {
    const runId = await fx.newRun("running");
    await createStagesForRun(runId);
    const result = await requestResearchPlanChanges(runId, "late note");
    assert.equal(result.success, false);
    assert.equal((await sql`SELECT 1 FROM research_plan_feedback WHERE research_run_id = ${runId}`).length, 0);
    const blank = await fx.newRun("waiting_for_human");
    await createStagesForRun(blank);
    await sql`UPDATE research_stages SET status = 'waiting_for_human' WHERE research_run_id = ${blank} AND stage_key = 'research_plan'`;
    assert.equal((await requestResearchPlanChanges(blank, "   ")).success, false);
    assert.equal((await sql`SELECT 1 FROM research_plan_feedback WHERE research_run_id = ${blank}`).length, 0);
  });

  test("V-3.4: transient failures stop at max_retries, counted in the column", async () => {
    const runId = await fx.newRun();
    await createStagesForRun(runId);
    let calls = 0;
    STAGE_HANDLERS.intake = { stageKey: "intake", async execute() {
      calls += 1;
      throw new ResearchAgentRunError("Agent attempts exhausted: Provider HTTP 529: overloaded_error", {} as any, { error_type: "server_error" });
    } };
    let result;
    try { result = await runResearchPipeline(runId); } finally { STAGE_HANDLERS.intake = intake; }
    assert.equal(calls, 3, "intake has max_retries 2");
    assert.equal(result.status, "needs_more_work");
    const [stage] = await sql`SELECT transient_failures FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'intake'`;
    assert.equal(Number(stage.transient_failures), 2);
  });
});
