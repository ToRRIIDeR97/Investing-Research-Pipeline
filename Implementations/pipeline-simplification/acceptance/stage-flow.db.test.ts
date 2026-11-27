// Worker-visible acceptance tests for Implementations/pipeline-simplification (AC-1, AC-4, AC-5, AC-7), database-backed.
// Run: RUN_DB_INTEGRATION=1 RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock DATABASE_URL=<test db> \
//        npx tsx --test --test-concurrency=1 Implementations/pipeline-simplification/acceptance/stage-flow.db.test.ts
// Use a test database (research_os_lean_test), never one a research worker polls. Don't weaken or skip these.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { MockProvider } from "../../../src/lib/agent-harness/providers/mock";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import { getTeamRequests, requestMissingResearch } from "../../../src/lib/research/team";
import { validateReviewOutcome } from "../../../src/lib/workflow/validators";
import { cleanup, createRun, drain, loadEnv, runState, saveBatch, scriptModel, skipDb, stageCtx, stageStatuses, type Run }
  from "../../research-request-routing/acceptance/fixtures";

loadEnv();
const skip = skipDb;
const at = (key: string) => Object.fromEntries(STAGE_CONFIGS.map(s => [s.key,
  s.key === key ? "running" : STAGE_CONFIGS.findIndex(x => x.key === s.key) < STAGE_CONFIGS.findIndex(x => x.key === key) ? "completed" : "pending"]));

async function reviewTask(sql: postgres.Sql, run: Run, verdict: string) {
  const [stage] = await sql`SELECT id FROM research_stages WHERE research_run_id = ${run.runId} AND stage_key = 'ai_reviewer'`;
  await sql`INSERT INTO research_tasks (research_run_id, stage_id, task_key, task_type, agent_name, status, input_json, output_json)
    VALUES (${run.runId}, ${stage.id}, 'report:review', 'ai_review', 'research-reviewer', 'completed', ${sql.json({})},
      ${sql.json({ review_verdict: verdict, findings: [{ section_id: "valuation", category: "calculation", severity: "critical", issue: "Terminal value is 106% of value." }] })})`;
}
const resets = (sql: postgres.Sql, runId: string) => sql`SELECT kind, status FROM research_run_resets WHERE research_run_id = ${runId}`;

// ---------- AC-1: the review verdict doesn't fail the review stage ----------

test("AC-1: a needs_more_work review validates the review stage, with the verdict as a warning", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql, at("ai_reviewer"));
  try {
    await reviewTask(sql, run, "needs_more_work");
    const result = await validateReviewOutcome(run.runId);
    assert.equal(result.valid, true, `errors: ${result.errors.join("; ")}`);
    assert.ok(result.warnings.some(w => /needs_more_work/.test(w)), `warnings: ${result.warnings.join("; ")}`);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-1: a missing review still fails the review stage", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql, at("ai_reviewer"));
  try {
    const result = await validateReviewOutcome(run.runId);
    assert.equal(result.valid, false);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

// ---------- AC-5 / AC-7: an owner's answer never reruns a stage or pauses the run ----------

async function ownerAsksRerun(sql: postgres.Sql, run: Run, capture?: string[]) {
  const valuation = await saveReportArtifact(sql, run, "valuation_scenario_set", `${run.assetSlug}-valuation`,
    { artifact_type: "valuation_scenario_set", fixture: run.runId });
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : { status: "answered",
    answer: "The 2026 tax rate of 9% conflicts with the nine-month rate of 21.8%.", evidence_ids: [], artifact_ids: [String((valuation as any).id)], requires_rerun: true });
  if (capture) {
    // Rules travel in request.system (cached prefix) as well as request.prompt: record both for the owner's call.
    const scripted = MockProvider.prototype.stream;
    MockProvider.prototype.stream = function (this: any, request: any, signal: AbortSignal) {
      capture.push(`${request.system ?? ""}\n${request.prompt ?? ""}`);
      return scripted.call(this, request, signal);
    } as any;
  }
  try {
    await saveBatch(sql, run, [{ id: "request-1-1", role: "valuation", material: true, needs_sources: false, source_role: "regulatory_filing",
      question: "Reconcile the 2026 tax rate used in the valuation with the nine-month effective rate." }]);
    await drain(sql, run);
  } finally { model.restore(); }
  return model;
}

test("AC-5: an owner answer with requires_rerun reopens nothing and is kept without the flag", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql, at("report_draft"));
  try {
    const model = await ownerAsksRerun(sql, run);
    assert.equal(model.answers().length, 1, "the owner answered once");
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "running", "the run keeps running");
    assert.equal(state.requestReset, null, "no approval is pending");
    assert.equal((await stageStatuses(sql, run.runId)).asset_valuation, "completed", "the valuation is not reopened");
    assert.equal((await resets(sql, run.runId)).length, 0, "no reset row of any kind");
    const response = (await getTeamRequests(sql, run.runId))!.requests.find(r => r.id === "request-1-1")!.response!;
    assert.equal(response.status, "answered");
    assert.match(response.answer, /nine-month rate/);
    assert.equal(response.requires_rerun, undefined, "requires_rerun is not stored");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-5: the owner's prompt no longer offers requires_rerun", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql, at("report_draft"));
  try {
    const sent: string[] = [];
    const model = await ownerAsksRerun(sql, run, sent);
    assert.equal(model.answers().length, 1);
    const answerCall = sent.find(text => /team_answer/.test(text));
    assert.ok(answerCall, "the owner's request was captured");
    assert.ok(!/requires_rerun/.test(answerCall!), "neither the system rules nor the prompt mention requires_rerun");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-7: with the automatic rerun already used, the same answer still never pauses the run", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql, at("report_draft"));
  try {
    await sql`INSERT INTO research_run_resets (research_run_id, kind, status, stages, request_ids, round)
      VALUES (${run.runId}, 'auto', 'applied', ${["asset_valuation", "decision_synthesis"]}::text[], ${["request-0-1"]}::text[], 1)`;
    await ownerAsksRerun(sql, run);
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "running");
    assert.equal(state.requestReset, null);
    assert.deepEqual((await resets(sql, run.runId)).map(r => r.kind), ["auto"], "no approval row is added");
    const stagesNow = await stageStatuses(sql, run.runId);
    assert.equal(stagesNow.report_draft, "running", "the report stage is not paused");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

// ---------- AC-4: one pre-draft planner round per run ----------

test("AC-4: a second pre-draft request call makes no planner call and adds no round", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql, at("report_draft"));
  const model = scriptModel(packet => packet.output_contract === "team_requests" ? { requests: [{ role: "financials",
    question: "Restate Q3 2026 segment operating income.", material: true, needs_sources: false, source_role: "regulatory_filing" }] } : undefined);
  try {
    await assert.rejects(requestMissingResearch(sql, stageCtx(run), [], "pre_draft", "report_draft"), /investigating report requests/i);
    const first = (await getTeamRequests(sql, run.runId))!;
    assert.equal(first.round, 1);
    await saveBatch(sql, run, first.requests.map(r => ({ ...r, response: { status: "answered", answer: "Restated.", evidence_ids: [], artifact_ids: [] } })),
      { round: 1, state: "answered" });
    const plannerCalls = () => model.calls.filter(c => c.contract === "team_requests").length;
    assert.equal(plannerCalls(), 1);
    await requestMissingResearch(sql, stageCtx(run), [{ category: "research_gap", question: "Blocked outline question." }], "pre_draft", "report_draft");
    assert.equal(plannerCalls(), 1, "no second planner call");
    assert.equal((await getTeamRequests(sql, run.runId))!.round, 1, "still one round");
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
