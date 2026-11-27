// An analysis_rework request (since pipeline-simplification, only the pre-draft valuation check raises one) reopens its
// owning stage once, with no model call, and is answered after the rerun.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { processResearchRequests, getTeamRequests, nextRequestBatch, reworkRequests } from "../src/lib/research/team";
import { cleanup, createRun, loadEnv, runState, saveBatch, scriptModel, skipDb as skip, stageCtx, stageStatuses } from "../Implementations/research-request-routing/acceptance/fixtures";

loadEnv();
process.env.RESEARCH_ACCEPTANCE_PROVIDER = "mock";

test("an analysis_rework request reruns asset_valuation once, then is answered without another rerun", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const model = scriptModel(() => undefined);
  try {
    // pipeline-simplification: the review opens no post-review round, so the rework request comes from a pre-draft
    // round (the valuation check's path). Was: a post-review round 3 after two answered pre-draft rounds.
    // pipeline-simplification: one round per run, so the rework is the run's first round (was round 2 after round 1).
    const batch = nextRequestBatch(null, reworkRequests([{ category: "analysis_rework", owner_stage: "asset_valuation", section_id: "valuation",
      severity: "high", issue: "The terminal multiple is applied to a capex-peak year." }]))!;
    await saveBatch(sql, run, batch.requests, { round: batch.round });

    assert.equal(await processResearchRequests(sql, stageCtx(run)), true, "stages were reopened");
    assert.equal((await runState(sql, run.runId)).status, "running", "an automatic rerun needs no reviewer");
    assert.equal(model.answers().length, 0, "no owner call for a rework request");
    const stages = await stageStatuses(sql, run.runId);
    assert.equal(stages.asset_valuation, "pending");
    assert.equal(stages.decision_synthesis, "pending");
    assert.equal(stages.operating_scenarios, "completed", "upstream stages stay");
    const reopened = await getTeamRequests(sql, run.runId);
    assert.equal(reopened!.state, "processing");
    assert.equal(reopened!.requests[0].reworked, true);
    assert.equal(reopened!.requests[0].response, undefined);
    assert.ok((await runState(sql, run.runId)).autoReset, "the run's one automatic rerun is used");

    await sql`UPDATE research_stages SET status = 'completed' WHERE research_run_id = ${run.runId} AND stage_key = ANY(${reopened!.rerun_stages!}::text[])`;
    await processResearchRequests(sql, stageCtx(run));
    const after = await getTeamRequests(sql, run.runId);
    assert.equal(after!.state, "answered");
    assert.equal(after!.round, 1, "pipeline-simplification: the round survives (was the post_review_round marker, 3)");
    assert.match(after!.requests[0].response!.answer, /was rerun/);
    assert.equal(after!.requests[0].response!.requires_rerun, undefined);
    assert.equal((await stageStatuses(sql, run.runId)).asset_valuation, "completed", "no second rerun");
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
