// Database-backed fixes from paid META run 27644c35: a granted re-run does not ask again, and effective_config writes
// send only text parameters. Skipped unless RUN_DB_INTEGRATION=1.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { dependentStages } from "../src/lib/research/team-plan";
import { getTeamRequests, processResearchRequests } from "../src/lib/research/team";
import { saveReportArtifact } from "../src/lib/research/reporting/store";
import { recordEffectiveTaskConfig, taskExecution } from "../src/lib/research/model-tiering";
import {
  cleanup, createRun, drain, loadEnv, REQUEST_1_4, runState, saveBatch, scriptModel, skipDb as skip, stageCtx, stageStatuses,
} from "../Implementations/research-request-routing/acceptance/fixtures";

loadEnv();

test("a granted re-run is answered by the recomputed artifacts and never requests the same re-run again", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const run = await createRun(sql);
  let valuationId = "";
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : {
    status: "answered", answer: "The schedule discounts from the wrong base date; the valuation must be recomputed.",
    evidence_ids: [], artifact_ids: [valuationId], requires_rerun: true });
  try {
    valuationId = String((await saveReportArtifact(sql, run, "valuation_scenario_set", `${run.assetSlug}-valuation`,
      { artifact_type: "valuation_scenario_set", valuation_status: "withheld", fixture: run.runId })).id);
    await saveBatch(sql, run, [REQUEST_1_4]);
    await drain(sql, run);
    const reset = dependentStages(["asset_valuation"]);
    assert.equal((await stageStatuses(sql, run.runId)).asset_valuation, "pending", "fixture: the first re-run reset the stage");
    assert.equal(model.answers().length, 1);
    // The worker recomputes the stages; the report stage processes the batch again.
    const recomputed = String((await saveReportArtifact(sql, run, "valuation_scenario_set", `${run.assetSlug}-valuation`,
      { artifact_type: "valuation_scenario_set", valuation_status: "withheld", fixture: run.runId, recomputed: true })).id);
    for (const key of reset) {
      await sql`UPDATE research_stages SET status = ${key === "ai_reviewer" ? "running" : "completed"}
        WHERE research_run_id = ${run.runId} AND stage_key = ${key}`;
    }
    await sql`UPDATE research_stages SET status = 'pending' WHERE research_run_id = ${run.runId} AND stage_key IN ('human_review', 'export', 'refresh_schedule')`;
    for (let i = 0; i < 3; i++) await processResearchRequests(sql, stageCtx(run));
    assert.equal(model.answers().length, 1, "the owner is not asked again");
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "running");
    assert.equal(state.metadata.request_reset ?? null, null, "no second reset is proposed");
    const statuses = await stageStatuses(sql, run.runId);
    for (const key of reset.filter(key => !["ai_reviewer", "human_review", "export", "refresh_schedule"].includes(key))) assert.equal(statuses[key], "completed", key);
    const batch = await getTeamRequests(sql, run.runId);
    assert.equal(batch?.state, "answered");
    const [request] = batch!.requests;
    assert.equal(request.response?.status, "answered");
    assert.equal(request.response?.resolved_by, "system:rerun");
    assert.equal(request.response?.requires_rerun, undefined);
    assert.ok(request.response?.artifact_ids.includes(recomputed), "the recomputed valuation answers the request");
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("effective_config task writes send only text parameters, whatever the inputs' runtime types", { skip }, async () => {
  // A fresh connection without prepared statements, as each stage handler opens one.
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, prepare: false });
  const run = await createRun(sql);
  try {
    const execution = { ...taskExecution({ agentName: "asset-analyst", modelTier: "premium", stageKey: "business_process_analysis" }), agentName: "asset-analyst" };
    // Boxed strings, as a caller that passed a wrapped value would; the old statement bound objects as parameters.
    await recordEffectiveTaskConfig(sql, new String(run.runId) as unknown as string, new String("management_assessment") as unknown as string,
      { ...execution, model: new String(execution.model) as unknown as string });
    await Promise.all(["research_framing", "metric_normalization", "management_assessment"].map(type =>
      recordEffectiveTaskConfig(sql, run.runId, type, { ...execution, model: `${execution.model}-${type}` })));
    const [row] = await sql`SELECT metadata_json->'effective_config'->'tasks' AS tasks FROM research_runs WHERE id = ${run.runId}`;
    assert.deepEqual(Object.keys(row.tasks).sort(), ["management_assessment", "metric_normalization", "research_framing"]);
    assert.equal(row.tasks.management_assessment.effort, "high");
    assert.deepEqual([...row.tasks.management_assessment.models].sort(), [execution.model, `${execution.model}-management_assessment`].sort());
    assert.equal(row.tasks.research_framing.agent, "asset-analyst");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
