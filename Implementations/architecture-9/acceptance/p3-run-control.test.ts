import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { NextRequest } from "next/server";
import { ResearchAgentRunError } from "../../../src/lib/agent-harness/errors";
import { STAGE_HANDLERS } from "../../../src/lib/research/handlers";
import { runResearchPipeline } from "../../../src/lib/research/pipeline-runner";
import { RequestResetError, approveRequestReset, createStagesForRun, requestResearchPlanChanges } from "../../../src/lib/workflow/orchestrator";
import { GET as runRoute } from "../../../src/app/api/research-runs/[id]/route";
import { db, sqlClient } from "../../../src/db";
import { DB, code, runFixture, sourceFiles } from "./fixtures";

test("AC-3.7: run-control state is no longer read from or written to the JSON columns", () => {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    const source = code(file);
    if (/request_auto_reset/.test(source)) hits.push(`${file}: request_auto_reset`);
    if (/metadata(_json)?\s*(\?\.|\.|->>?\s*'|\['|\[")\s*request_reset\b/.test(source)) hits.push(`${file}: metadata request_reset`);
    if (/metadata(_json)?\s*(\?\.|\.|->>?\s*'|\['|\[")\s*research_plan_feedback\b/.test(source) || /'\{research_plan_feedback\}'/.test(source))
      hits.push(`${file}: metadata research_plan_feedback`);
    if (/validation_result_json\s*(\?\.|\.|->>?\s*')\s*transient_failures/.test(source) || /jsonb_build_object\('transient_failures'/.test(source))
      hits.push(`${file}: validation_result_json transient_failures`);
  }
  assert.deepEqual(hits, []);
});

describe("typed run-control state", { skip: !DB }, () => {
  const fx = runFixture("runcontrol");
  const { sql } = fx;
  const intake = STAGE_HANDLERS.intake;
  const columns = async (table: string) => (await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`).map(row => String(row.column_name));

  before(async () => { process.env.RESEARCH_STAGE_RETRY_DELAY_MS = "1"; await fx.setup(); });
  after(async () => {
    STAGE_HANDLERS.intake = intake;
    await fx.teardown();
    // The run route uses the app's long-lived pools, which have no idle timeout; close them so the process exits.
    await sqlClient.end({ timeout: 5 });
    await (db as unknown as { $client: { end: (o: { timeout: number }) => Promise<void> } }).$client.end({ timeout: 5 });
  });

  test("AC-3.1: the tables and columns exist", async () => {
    for (const column of ["id", "research_run_id", "kind", "status", "stages", "request_ids", "round", "estimated_cost_usd", "decided_by", "decided_at", "created_at"])
      assert.ok((await columns("research_run_resets")).includes(column), `research_run_resets.${column}`);
    for (const column of ["id", "research_run_id", "notes", "requested_by", "requested_at"])
      assert.ok((await columns("research_plan_feedback")).includes(column), `research_plan_feedback.${column}`);
    const stages = await columns("research_stages");
    assert.ok(stages.includes("transient_failures") && stages.includes("last_transient_error"));
  });

  test("AC-3.2: plan feedback is stored as rows, in order, and not in metadata_json", async () => {
    const runId = await fx.newRun("waiting_for_human");
    await createStagesForRun(runId);
    const reopen = () => sql`UPDATE research_stages SET status = 'waiting_for_human' WHERE research_run_id = ${runId} AND stage_key = 'research_plan'`;
    await reopen();
    assert.deepEqual(await requestResearchPlanChanges(runId, "  Add the lending segment.  ", "reviewer-a"), { success: true });
    await reopen();
    assert.deepEqual(await requestResearchPlanChanges(runId, "Name two peers.", "reviewer-b"), { success: true });
    const rows = await sql`SELECT notes, requested_by FROM research_plan_feedback WHERE research_run_id = ${runId} ORDER BY requested_at, id`;
    assert.deepEqual(rows.map(row => [row.notes, row.requested_by]), [["Add the lending segment.", "reviewer-a"], ["Name two peers.", "reviewer-b"]]);
    const [run] = await sql`SELECT status, metadata_json FROM research_runs WHERE id = ${runId}`;
    assert.equal(run.status, "running");
    assert.equal(run.metadata_json.research_plan_feedback, undefined);
  });

  test("AC-3.3: a transient failure is counted in research_stages.transient_failures", async () => {
    const runId = await fx.newRun();
    await createStagesForRun(runId);
    let calls = 0;
    STAGE_HANDLERS.intake = { stageKey: "intake", async execute(ctx) {
      calls += 1;
      if (calls === 1) throw new ResearchAgentRunError("Agent attempts exhausted: Provider HTTP 529: overloaded_error", {} as any, { error_type: "server_error" });
      return intake.execute(ctx);
    } };
    try { await runResearchPipeline(runId); } finally { STAGE_HANDLERS.intake = intake; }
    assert.equal(calls, 2);
    const [stage] = await sql`SELECT status, transient_failures, last_transient_error, validation_result_json FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = 'intake'`;
    assert.equal(stage.status, "completed");
    assert.equal(Number(stage.transient_failures), 1);
    assert.match(String(stage.last_transient_error), /529/);
    assert.equal(stage.validation_result_json?.transient_failures, undefined);
  });

  test("AC-3.4: the re-run decision reads the pending row, never metadata_json", async () => {
    const legacy = await fx.newRun("waiting_for_human", { request_reset: { stages: ["asset_valuation"], request_ids: ["r1"] } });
    await createStagesForRun(legacy);
    await assert.rejects(approveRequestReset(legacy, { decision: "skip", actor: "tester" }), (error: unknown) =>
      error instanceof RequestResetError && /not paused on a request reset/.test(error.message));

    const typed = await fx.newRun("waiting_for_human");
    await createStagesForRun(typed);
    await sql`INSERT INTO research_run_resets (research_run_id, kind, status, stages, request_ids, estimated_cost_usd)
      VALUES (${typed}, 'approval', 'pending', ${["asset_valuation", "decision_synthesis"]}, ${["r1"]}, 1.25)`;
    // The pending row gets past the "not paused" check; with no team requests the decision stops at the next one.
    await assert.rejects(approveRequestReset(typed, { decision: "skip", actor: "tester" }), (error: unknown) =>
      error instanceof RequestResetError && /no team requests/.test(error.message));
    const [row] = await sql`SELECT status FROM research_run_resets WHERE research_run_id = ${typed}`;
    assert.equal(row.status, "pending", "a refused decision changes nothing");
  });

  test("AC-3.5: the run API exposes the pending re-run as request_reset", async () => {
    const runId = await fx.newRun("waiting_for_human");
    await createStagesForRun(runId);
    const get = async () => {
      const response = await runRoute(new NextRequest(`http://localhost/api/research-runs/${runId}`), { params: Promise.resolve({ id: runId }) });
      const body = await response.json();
      const run = body.data?.run ?? body.data ?? body.run ?? body;
      return run.request_reset;
    };
    assert.equal(await get(), null);
    await sql`INSERT INTO research_run_resets (research_run_id, kind, status, stages, request_ids, estimated_cost_usd)
      VALUES (${runId}, 'approval', 'pending', ${["asset_valuation"]}, ${["r1", "r2"]}, 2.5)`;
    const reset = await get();
    assert.deepEqual(reset.stages, ["asset_valuation"]);
    assert.deepEqual(reset.request_ids, ["r1", "r2"]);
    assert.equal(Number(reset.estimated_cost_usd), 2.5);
  });
});
