// Database-backed request processing: system answers (AC-1, AC-2), research memory (AC-3), collector (AC-4),
// bounded re-runs (AC-6) and the reset approval (AC-7). Skipped unless RUN_DB_INTEGRATION=1.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { dependentStages } from "../../../src/lib/research/team-plan";
import { getTeamRequests } from "../../../src/lib/research/team";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import {
  cleanup, createRun, drain, exported, fredCsv, loadEnv, MARKET_HISTORY, ORCHESTRATOR, PROXY_URL, proxyPage, REQUEST_1_2, REQUEST_1_3,
  REQUEST_1_4, REQUEST_1_5, RESET_ROUTE, RISK_FREE, runState, saveBatch, scriptModel, seedCost, skipDb as skip, stageStatuses, storeDoc,
  storeFred, stubWeb, type Run,
} from "./fixtures";

loadEnv();
const sorted = (values: string[]) => [...values].sort();
const cashFlowText = (run: Run) => ["Condensed Consolidated Statements of Cash Flows", "", "Three months ended March 31, 2026", "",
  `Purchases of property and equipment (18,997). Free cash flow fell as capital expenditures rose. Fixture ${run.runId}.`].join("\n");

test("AC-1, AC-2: market and FRED requests are answered by the system without a model call or stage change", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const model = scriptModel(() => undefined);
  const web = stubWeb();
  try {
    const artifact = await saveReportArtifact(sql, run, "market_price_history", `${run.assetSlug}-market-price-history`, MARKET_HISTORY);
    const fredId = await storeFred(sql, run, fredCsv(run.runId));
    await saveBatch(sql, run, [REQUEST_1_3, RISK_FREE]);
    const before = await stageStatuses(sql, run.runId);
    await drain(sql, run);
    const batch = await getTeamRequests(sql, run.runId);
    assert.deepEqual(await stageStatuses(sql, run.runId), before, "no stage is reset");
    assert.equal(model.answers().length, 0, "no team_answer model call");
    assert.equal(batch?.state, "answered");
    const [market, rate] = batch!.requests as any[];
    assert.equal(market.response?.status, "answered");
    assert.equal(market.response.resolved_by, "system:market-history");
    assert.deepEqual(market.response.artifact_ids, [String(artifact.id)]);
    assert.equal(rate.response?.status, "answered");
    assert.equal(rate.response.resolved_by, "system:fred");
    assert.deepEqual(rate.response.source_ids, [fredId]);
    assert.match(rate.response.answer, /5\.22/);
    assert.deepEqual(web.searches(), [], "a system answer needs no collector search");
  } finally { model.restore(); web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-3: other requests are answered by the owner from research-memory passages without resetting stages", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : {
    status: "answered", answer: "The Q1 2026 10-Q reports purchases of property and equipment of $18,997m for the three-month period.",
    evidence_ids: [], artifact_ids: [], source_ids: (packet.passages || []).map((p: any) => p.source_id).slice(0, 1) });
  try {
    const filingId = await storeDoc(sql, run, { title: "RFPQA 10-Q for the quarter ended March 31, 2026", content: cashFlowText(run), role: "regulatory_filing" });
    await saveBatch(sql, run, [REQUEST_1_2]);
    const before = await stageStatuses(sql, run.runId);
    await drain(sql, run);
    assert.deepEqual(await stageStatuses(sql, run.runId), before, "no stage is reset");
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM research_artifacts WHERE research_run_id = ${run.runId} AND status = 'needs_more_work'`;
    assert.equal(n, 0, "no artifact is invalidated");
    const answers = model.answers();
    assert.equal(answers.length, 1);
    assert.equal(answers[0].agent, "metric-normalizer", "the financials owner answers");
    assert.match(answers[0].prompt, /Purchases of property and equipment \(18,997\)/, "the retrieved passage is in the packet");
    const batch = await getTeamRequests(sql, run.runId);
    assert.equal(batch?.state, "answered");
    assert.equal(batch!.requests[0].response?.status, "answered");
    assert.deepEqual((batch!.requests[0].response as any).source_ids, [filingId]);
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-4: a request needing sources with no matching passages gets a collector search for new documents, then one answer", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const web = stubWeb({ [PROXY_URL]: proxyPage(run) }, () => [{ url: PROXY_URL, title: "2026 proxy statement" }]);
  const model = scriptModel(packet => {
    if (packet.output_contract !== "team_answer") return undefined;
    const cited = (packet.passages || []).map((p: any) => p.source_id);
    return cited.length
      ? { status: "answered", answer: "Jane Example is CEO since 2019; Omar Sample is CFO since 2021 and reports to the CEO.", evidence_ids: [], artifact_ids: [], source_ids: cited.slice(0, 1) }
      : { status: "needs_sources", answer: "The corpus holds no proxy statement.", evidence_ids: [], artifact_ids: [] };
  });
  try {
    const filingId = await storeDoc(sql, run, { title: "RFPQA annual report", content: cashFlowText(run), role: "regulatory_filing" });
    await saveBatch(sql, run, [REQUEST_1_5]);
    const before = await stageStatuses(sql, run.runId);
    await drain(sql, run);
    assert.deepEqual(await stageStatuses(sql, run.runId), before, "no stage is reset");
    assert.ok(web.searches().length >= 1, "the collector searched");
    const [doc] = await sql`SELECT sd.id FROM source_documents sd JOIN research_run_sources r ON r.source_document_id = sd.id
      WHERE r.research_run_id = ${run.runId} AND sd.url = ${PROXY_URL}`;
    assert.ok(doc, "the fetched proxy statement is linked to the run");
    const readers = model.calls.filter(c => c.agent === "source-reader");
    assert.ok(readers.length >= 1, "evidence is extracted from the new document");
    assert.ok(readers.every(c => c.prompt.includes(String(doc.id)) && !c.prompt.includes(filingId)), "only new documents are read");
    const answers = model.answers();
    assert.equal(answers.length, 1, "one answer attempt after the search");
    assert.equal(answers[0].packet.source_search_attempted, true);
    const batch = await getTeamRequests(sql, run.runId);
    assert.equal(batch!.requests[0].response?.status, "answered");
    assert.deepEqual((batch!.requests[0].response as any).source_ids, [String(doc.id)]);
    const attempts = await sql`SELECT id FROM source_retrieval_attempts WHERE research_run_id = ${run.runId}
      AND attempt_metadata_json->>'request_id' = ${REQUEST_1_5.id}`;
    assert.ok(attempts.length >= 1, "the search is recorded against the request");
  } finally { model.restore(); web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-4: when the search finds nothing the single answer attempt ends unavailable", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const web = stubWeb();
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined :
    { status: "needs_sources", answer: "The corpus holds no proxy statement or executive officer list.", evidence_ids: [], artifact_ids: [] });
  try {
    await saveBatch(sql, run, [REQUEST_1_5]);
    const before = await stageStatuses(sql, run.runId);
    await drain(sql, run);
    assert.deepEqual(await stageStatuses(sql, run.runId), before, "no stage is reset");
    assert.ok(web.searches().length >= 1, "the collector searched");
    assert.equal(model.answers().length, 1);
    const batch = await getTeamRequests(sql, run.runId);
    assert.equal(batch?.state, "answered");
    assert.equal(batch!.requests[0].response?.status, "unavailable");
  } finally { model.restore(); web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

/** A financials answer that asks for a re-run: 13 analysis stages, above the default limit of 6. */
async function pauseOnFinancialsRerun(sql: postgres.Sql, run: Run) {
  const record = await saveReportArtifact(sql, run, "historical_record", `${run.assetSlug}-historical-record`,
    { artifact_type: "historical_record", summary: `Capex series with year-to-date derived quarters. Fixture ${run.runId}.` });
  await seedCost(sql, run.runId, "historical_record", 0.38);
  await seedCost(sql, run.runId, "asset_valuation", 0.171);
  await seedCost(sql, run.runId, "ai_reviewer", 0.2);
  await seedCost(sql, run.runId, "company_genesis", 0.16);
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : {
    status: "answered", answer: "Q1 2026 capex is verified, but the Q3 2025 quarter must be captured as an observation and its consumers recomputed.",
    evidence_ids: [], artifact_ids: [String(record.id)], requires_rerun: true });
  try {
    await saveBatch(sql, run, [REQUEST_1_2]);
    await drain(sql, run);
  } finally { model.restore(); }
  return String(record.id);
}

test("AC-6: a re-run above the automatic limit pauses the run with its stages, requests and estimated cost", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await pauseOnFinancialsRerun(sql, run);
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "waiting_for_human");
    const reset = state.metadata.request_reset;
    assert.ok(reset, "metadata.request_reset is set");
    assert.deepEqual(sorted(reset.stages), sorted(dependentStages(["historical_record"])));
    assert.deepEqual(reset.request_ids, [REQUEST_1_2.id]);
    // Every reset stage's earlier cost, company_genesis included now that it reads the analytics digest.
    assert.ok(Math.abs(Number(reset.estimated_cost_usd) - 0.911) < 1e-6, `estimated cost ${reset.estimated_cost_usd}`);
    const statuses = await stageStatuses(sql, run.runId);
    assert.equal(statuses.ai_reviewer, "waiting_for_human");
    assert.equal(statuses.historical_record, "completed", "nothing is reset before approval");
    assert.equal(statuses.asset_valuation, "completed");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-6: the first re-run within the limit resets the owner stage and its dependents automatically", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
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
    assert.equal(model.answers().length, 1, "the owner answered before anything was reset");
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "running");
    assert.equal(state.metadata.request_reset ?? null, null, "no approval is needed");
    const statuses = await stageStatuses(sql, run.runId);
    for (const key of dependentStages(["asset_valuation"])) assert.equal(statuses[key], "pending", key);
    for (const key of ["source_discovery", "historical_record", "company_genesis", "operating_scenarios"]) assert.equal(statuses[key], "completed", key);
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-7: approving the re-run performs the reset and resumes the run", { skip }, async () => {
  const approveRequestReset = exported(ORCHESTRATOR, "approveRequestReset");
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const recordId = await pauseOnFinancialsRerun(sql, run);
    assert.equal((await runState(sql, run.runId)).status, "waiting_for_human", "fixture: the run is paused on the request reset");
    await approveRequestReset(run.runId, { decision: "rerun", actor: "qa-reviewer" });
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "running");
    assert.equal(state.metadata.request_reset ?? null, null);
    const statuses = await stageStatuses(sql, run.runId);
    for (const key of dependentStages(["historical_record"])) assert.equal(statuses[key], "pending", key);
    for (const key of ["source_discovery", "evidence_extraction"]) assert.equal(statuses[key], "completed", key);
    const [record] = await sql`SELECT status FROM research_artifacts WHERE id = ${recordId}`;
    assert.equal(record.status, "needs_more_work", "the reset invalidates the owner's artifacts as before");
    assert.equal((await getTeamRequests(sql, run.runId))?.state, "processing");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-7: skipping the re-run marks the request unavailable and lets the report continue", { skip }, async () => {
  const approveRequestReset = exported(ORCHESTRATOR, "approveRequestReset");
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await pauseOnFinancialsRerun(sql, run);
    assert.equal((await runState(sql, run.runId)).status, "waiting_for_human", "fixture: the run is paused on the request reset");
    await approveRequestReset(run.runId, { decision: "skip", actor: "qa-reviewer" });
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "running");
    assert.equal(state.metadata.request_reset ?? null, null);
    const statuses = await stageStatuses(sql, run.runId);
    assert.equal(statuses.historical_record, "completed", "nothing is reset");
    assert.ok(["running", "pending"].includes(statuses.ai_reviewer), `ai_reviewer is ${statuses.ai_reviewer}`);
    const batch = await getTeamRequests(sql, run.runId);
    assert.equal(batch?.state, "answered");
    assert.equal(batch!.requests[0].response?.status, "unavailable");
    assert.match(batch!.requests[0].response!.answer, /Skipped by reviewer: re-run not approved/);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-7: the route rejects an unknown decision with 400 and queues nothing", { skip }, async () => {
  const POST = exported(RESET_ROUTE, "POST");
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await pauseOnFinancialsRerun(sql, run);
    // The 200 path queues a real job, which a worker polling this database would run; it is a manual check.
    const response = await POST(new NextRequest(`http://localhost/api/research-runs/${run.runId}/request-reset`, { method: "POST",
      body: JSON.stringify({ decision: "approve", actor: "qa-reviewer" }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ id: run.runId }) });
    assert.equal(response.status, 400, await response.clone().text());
    const jobs = await sql`SELECT id FROM research_run_jobs WHERE research_run_id = ${run.runId}`;
    assert.equal(jobs.length, 0, "nothing is queued");
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "waiting_for_human");
    assert.ok(state.metadata.request_reset, "the pause is unchanged");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
