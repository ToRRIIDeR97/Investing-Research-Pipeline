// Independent database sequences for request routing (AC-1..AC-4, AC-6..AC-8). Skipped unless RUN_DB_INTEGRATION=1.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { dependentStages } from "../../../src/lib/research/team-plan";
import { getTeamRequests, processResearchRequests, requestMissingResearch } from "../../../src/lib/research/team";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import {
  cleanup, createRun, drain, exported, finishReopenedStages, fredWithTrailingBlank, loadEnv, ORCHESTRATOR, REPORT_STAGE, RESET_ROUTE, runState, saveBatch,
  scriptModel, seedCost, skipDb as skip, stageCtx, stageStatuses, storeDoc, storeFred, stubWeb, VERIFIED_HISTORY,
} from "./fixtures";

loadEnv();
const sorted = (values: string[]) => [...values].sort();
const ask = (id: string, role: string, source_role: string, question: string, needs_sources = false) =>
  ({ id, role, source_role, question, material: true, needs_sources });
const unavailable = (text = "Not disclosed in the supplied corpus.") => ({ status: "unavailable", answer: text, evidence_ids: [], artifact_ids: [] });

test("AC-1: the latest validated market_price_history version answers, not a superseded one", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const model = scriptModel(() => undefined);
  try {
    const scope = `${run.assetSlug}-market-price-history`;
    await saveReportArtifact(sql, run, "market_price_history", scope, { ...VERIFIED_HISTORY, bars_available: 760, last_trading_day: "2025-09-30" });
    const latest = await saveReportArtifact(sql, run, "market_price_history", scope, VERIFIED_HISTORY);
    await saveBatch(sql, run, [ask("request-1-1", "data", "market_data", "Provide the verified daily price history through the valuation date.", true)]);
    await drain(sql, run);
    const response = (await getTeamRequests(sql, run.runId))!.requests[0].response as any;
    assert.equal(response?.resolved_by, "system:market-history");
    assert.deepEqual(response.artifact_ids, [String(latest.id)]);
    assert.match(response.answer, /2026-09-30/);
    assert.equal(model.answers().length, 0);
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-2: the FRED document must belong to the run; the run's own series is read from storage past a holiday blank", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const owner = await createRun(sql), other = await createRun(sql);
  const model = scriptModel(packet => packet.output_contract === "team_answer" ? unavailable("No risk-free series in this run's corpus.") : undefined);
  const question = "Which risk-free rate supports the discount rate used in the valuation?";
  const inflation = ask("request-1-2", "valuation", "macro_dataset", "What was the US CPI inflation rate for August 2026?");
  try {
    const fredId = await storeFred(sql, owner, fredWithTrailingBlank(owner.runId.replace(/-/g, "")));
    await saveBatch(sql, owner, [ask("request-1-1", "valuation", "regulatory_filing", question), inflation]);
    await saveBatch(sql, other, [ask("request-1-1", "valuation", "regulatory_filing", question)]);
    await drain(sql, owner);
    await drain(sql, other);
    const own = (await getTeamRequests(sql, owner.runId))!.requests[0].response as any;
    assert.equal(own?.resolved_by, "system:fred");
    assert.deepEqual(own.source_ids, [fredId]);
    assert.match(own.answer, /4\.12/);
    assert.match(own.answer, /2026-10-09/);
    const foreign = (await getTeamRequests(sql, other.runId))!.requests[0].response as any;
    assert.notEqual(foreign?.resolved_by, "system:fred", "another run's FRED document is not used");
    assert.ok(!(foreign?.source_ids || []).includes(fredId));
    const cpi = (await getTeamRequests(sql, owner.runId))!.requests[1].response as any;
    assert.notEqual(cpi?.resolved_by, "system:fred", "a macro_dataset question about inflation is not answered with DGS10");
    const asked = model.answers().map(c => c.packet.request?.id).sort();
    assert.deepEqual(asked, ["request-1-1", "request-1-2"], "the inflation question and the run without FRED go to the owner");
  } finally { model.restore(); await cleanup(sql, [owner.runId, other.runId], [owner.assetId, other.assetId]); await sql.end(); }
});

test("AC-3: an empty corpus still gets an owner answer, with no search and no reset", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const web = stubWeb();
  let recordId = "";
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined :
    { status: "answered", answer: "The historical record reports no Reality Labs cost lines by quarter.", evidence_ids: [], artifact_ids: [recordId] });
  try {
    recordId = String((await saveReportArtifact(sql, run, "historical_record", `${run.assetSlug}-historical-record`,
      { artifact_type: "historical_record", summary: `Segment table without cost lines. ${run.runId}` })).id);
    await saveBatch(sql, run, [ask("request-1-1", "financials", "regulatory_filing", "Which Reality Labs cost lines are disclosed for each quarter of 2026?")]);
    const before = await stageStatuses(sql, run.runId);
    await drain(sql, run);
    assert.deepEqual(await stageStatuses(sql, run.runId), before);
    assert.deepEqual(web.searches(), [], "needs_sources is false and the answer is not needs_sources");
    assert.equal(model.answers().length, 1);
    assert.deepEqual(model.answers()[0].packet.passages || [], []);
    const response = (await getTeamRequests(sql, run.runId))!.requests[0].response as any;
    assert.equal(response?.status, "answered");
    assert.deepEqual(response.artifact_ids, [recordId]);
  } finally { model.restore(); web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-3: passages come only from documents of the request's source role", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : { status: "answered",
    answer: "Capital expenditures were 4,410 in the quarter.", evidence_ids: [], artifact_ids: [], source_ids: (packet.passages || []).map((p: any) => p.source_id) });
  try {
    const filing = await storeDoc(sql, run, { title: "VHQA 10-Q Q2 2026", role: "regulatory_filing",
      content: `Cash Flows\n\nCapital expenditures (4,410) in the quarter ended June 30, 2026. ${run.runId}` });
    const release = await storeDoc(sql, run, { title: "VHQA Q2 2026 earnings release", role: "earnings_release",
      content: `Highlights\n\nCapital expenditures of 9,999 guided for the full year. ${run.runId}` });
    await saveBatch(sql, run, [ask("request-1-1", "financials", "regulatory_filing", "Confirm quarterly capital expenditures for Q2 2026 from the 10-Q.")]);
    await drain(sql, run);
    const prompt = model.answers()[0]?.prompt || "";
    assert.match(prompt, /4,410/);
    assert.doesNotMatch(prompt, /9,999/, "the earnings release has another source role");
    const response = (await getTeamRequests(sql, run.runId))!.requests[0].response as any;
    assert.ok(response.source_ids.includes(filing) && !response.source_ids.includes(release));
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-3: an interrupted answer is retried on the next pass without any stage reset", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  let recordId = "";
  const model = scriptModel((packet, call) => packet.output_contract !== "team_answer" ? undefined :
    call === 1 ? new Error("Simulated provider interruption") :
      { status: "answered", answer: "Segment margins are derived from the historical record.", evidence_ids: [], artifact_ids: [recordId] });
  try {
    recordId = String((await saveReportArtifact(sql, run, "historical_record", `${run.assetSlug}-historical-record`,
      { artifact_type: "historical_record", summary: `Segment margins. ${run.runId}` })).id);
    await saveBatch(sql, run, [ask("request-1-1", "financials", "regulatory_filing", "Derive segment operating margins for 2026.")]);
    const before = await stageStatuses(sql, run.runId);
    await assert.rejects(drain(sql, run), /Simulated provider interruption/);
    assert.deepEqual(await stageStatuses(sql, run.runId), before, "a failed answer resets nothing");
    await drain(sql, run);
    assert.deepEqual(await stageStatuses(sql, run.runId), before);
    assert.equal((await getTeamRequests(sql, run.runId))!.requests[0].response?.status, "answered");
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-4: with an empty corpus a needs_sources request is answered from the newly fetched document", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const url = "https://harbor-board.example/investors/governance/board-committees";
  const page = `<html><head><title>${run.assetName} board committees</title><meta property="article:published_time" content="2026-05-02"></head><body>
    ${`<p>${run.assetName} board governance: the audit committee is chaired by Ana Verify since 2023 and the compensation committee by Ben Check since 2024. ${run.runId}</p>`.repeat(8)}</body></html>`;
  const web = stubWeb({ [url]: page }, () => [{ url, title: "Board committees" }]);
  const model = scriptModel(packet => {
    if (packet.output_contract !== "team_answer") return undefined;
    const cited = (packet.passages || []).map((p: any) => p.source_id);
    return cited.length ? { status: "answered", answer: "Ana Verify chairs the audit committee since 2023.", evidence_ids: [], artifact_ids: [], source_ids: [cited[0]] }
      : { status: "needs_sources", answer: "No governance document.", evidence_ids: [], artifact_ids: [] };
  });
  try {
    await saveBatch(sql, run, [ask("request-1-1", "business", "proxy_and_governance", "Who chairs the audit and compensation committees, and since when?", true)]);
    const before = await stageStatuses(sql, run.runId);
    await drain(sql, run);
    assert.deepEqual(await stageStatuses(sql, run.runId), before);
    const [doc] = await sql`SELECT id FROM source_documents WHERE research_run_id = ${run.runId} AND url = ${url}`;
    assert.ok(doc, "the fetched page is stored for the run");
    assert.equal(model.answers().length, 1);
    const response = (await getTeamRequests(sql, run.runId))!.requests[0].response as any;
    assert.equal(response?.status, "answered");
    assert.deepEqual(response.source_ids, [String(doc.id)]);
  } finally { model.restore(); web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-6: after an automatic reset completes, a second requires_rerun pauses instead of resetting again", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  let version = 0;
  const model = scriptModel(packet => {
    if (packet.output_contract !== "team_answer") return undefined;
    const valuation = (packet.artifacts || []).find((a: any) => a.artifact_type === "valuation_scenario_set");
    return { status: "answered", answer: `Discounting still uses the wrong base date (pass ${version}).`, evidence_ids: [],
      artifact_ids: valuation ? [valuation.id] : [], requires_rerun: true };
  });
  const saveValuation = async () => saveReportArtifact(sql, run, "valuation_scenario_set", `${run.assetSlug}-valuation`,
    { artifact_type: "valuation_scenario_set", pass: ++version, fixture: run.runId });
  try {
    await saveValuation();
    await seedCost(sql, run.runId, "asset_valuation", 0.25);
    await seedCost(sql, run.runId, "decision_synthesis", 0.1);
    await seedCost(sql, run.runId, "ai_reviewer", 0.05);
    await seedCost(sql, run.runId, "historical_record", 0.4);
    const request = ask("request-1-1", "valuation", "regulatory_filing", "Confirm whether discounting starts at 2026-06-30 or 2025-12-31.");
    await saveBatch(sql, run, [request]);
    await drain(sql, run);
    assert.equal(model.answers().length, 1, "the owner answered and asked for a re-run");
    assert.equal((await runState(sql, run.runId)).status, "running", "the first re-run is automatic");
    assert.equal((await stageStatuses(sql, run.runId)).asset_valuation, "pending");
    await drain(sql, run);
    assert.equal(model.answers().length, 1, "no new answer before the reopened stages complete");
    await finishReopenedStages(sql, run.runId);
    await saveValuation();
    await drain(sql, run);
    assert.equal(model.answers().length, 2, "the owner answers again after the re-run");
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "waiting_for_human");
    assert.deepEqual(state.metadata.request_reset?.request_ids, [request.id]);
    assert.deepEqual(sorted(state.metadata.request_reset.stages), sorted(dependentStages(["asset_valuation"])));
    assert.ok(Math.abs(Number(state.metadata.request_reset.estimated_cost_usd) - 0.4) < 1e-6, `estimate ${state.metadata.request_reset.estimated_cost_usd}`);
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

async function pauseOnBusinessRerun(sql: postgres.Sql, run: Awaited<ReturnType<typeof createRun>>) {
  const genesis = await saveReportArtifact(sql, run, "company_genesis", `${run.assetSlug}-genesis`, { artifact_type: "company_genesis", fixture: run.runId });
  const model = scriptModel(packet => packet.output_contract !== "team_answer" ? undefined : { status: "answered",
    answer: "The founding history contradicts the strategic DNA; company_genesis and its consumers must rerun.", evidence_ids: [],
    artifact_ids: [String(genesis.id)], requires_rerun: true });
  try {
    await saveBatch(sql, run, [ask("request-1-1", "business", "founder_and_company_history", "Reconcile the founding year across the history sources.")]);
    await drain(sql, run);
  } finally { model.restore(); }
  assert.equal((await runState(sql, run.runId)).status, "waiting_for_human", "fixture: 11 analysis stages need approval");
}

test("AC-7: after skip the report continues; the decision cannot be applied twice", { skip }, async () => {
  const approveRequestReset = exported(ORCHESTRATOR, "approveRequestReset");
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await pauseOnBusinessRerun(sql, run);
    await assert.rejects(() => approveRequestReset(run.runId, { decision: "approve", actor: "qa" }));  // an unknown decision
    assert.ok((await runState(sql, run.runId)).metadata.request_reset, "a rejected decision leaves the pause in place");
    await approveRequestReset(run.runId, { decision: "skip", actor: "qa" });
    await assert.rejects(() => approveRequestReset(run.runId, { decision: "rerun", actor: "qa" }));  // nothing is pending any more
    assert.equal((await stageStatuses(sql, run.runId)).company_genesis, "completed");
    const model = scriptModel(packet => packet.output_contract === "team_requests" ? { requests: [] } : undefined);
    try {
      assert.equal(await processResearchRequests(sql, stageCtx(run)), false, "an answered batch needs no work");
      await requestMissingResearch(sql, stageCtx(run));
      assert.equal(model.answers().length, 0, "the skipped request is not asked again");
      const writer = model.calls.find(c => c.contract === "team_requests");
      assert.equal(writer?.packet.previous_requests[0].response.status, "unavailable", "the report agent sees the skipped request");
    } finally { model.restore(); }
    assert.equal((await runState(sql, run.runId)).status, "running");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-6, AC-7: an approved re-run does not use up the run's automatic reset", { skip }, async () => {
  const approveRequestReset = exported(ORCHESTRATOR, "approveRequestReset");
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const asked: Record<string, number> = {};
  let version = 0;
  const saveRecord = () => saveReportArtifact(sql, run, "historical_record", `${run.assetSlug}-historical-record`,
    { artifact_type: "historical_record", pass: ++version, fixture: run.runId });
  const model = scriptModel(packet => {
    if (packet.output_contract === "team_requests") return { requests: packet.previous_requests.length === 1 ? [{ role: "valuation",
      question: "Recompute the terminal value with the corrected diluted share count.", material: true, needs_sources: false, source_role: "regulatory_filing" }] : [] };
    if (packet.output_contract !== "team_answer") return undefined;
    const id = String(packet.request?.id);
    asked[id] = (asked[id] || 0) + 1;
    const cite = (packet.artifacts || []).map((a: any) => a.id).slice(0, 1);
    if (id === "request-1-1" && asked[id] > 1) return { status: "answered", answer: "The recaptured quarter now reconciles.", evidence_ids: [], artifact_ids: cite };
    return { status: "answered", answer: "The owner's artifact must be recomputed.", evidence_ids: [], artifact_ids: cite, requires_rerun: true };
  });
  try {
    await saveRecord();
    await saveBatch(sql, run, [ask("request-1-1", "financials", "regulatory_filing", "Recapture the Q3 2025 cash flow quarter as an observation.")]);
    await drain(sql, run);
    assert.equal((await runState(sql, run.runId)).status, "waiting_for_human", "10 analysis stages need approval");
    await approveRequestReset(run.runId, { decision: "rerun", actor: "qa" });
    await finishReopenedStages(sql, run.runId);
    await saveRecord();
    await drain(sql, run);
    assert.equal((await getTeamRequests(sql, run.runId))?.state, "answered", "the owner answered again after the approved re-run");
    await assert.rejects(requestMissingResearch(sql, stageCtx(run)), /investigating report requests/);
    await drain(sql, run);
    const state = await runState(sql, run.runId);
    assert.equal(state.status, "running", "the small valuation re-run is automatic");
    assert.equal(state.metadata.request_reset ?? null, null);
    assert.equal((await stageStatuses(sql, run.runId)).asset_valuation, "pending");
  } finally { model.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-7: a request-reset decision cannot pass the research-plan gate", { skip }, async () => {
  const approveRequestReset = exported(ORCHESTRATOR, "approveRequestReset");
  const sql = postgres(process.env.DATABASE_URL!);
  const done: Record<string, string> = { intake: "completed", asset_identity: "completed", archetype_composition: "completed", research_plan: "waiting_for_human" };
  const run = await createRun(sql, Object.fromEntries(Object.keys(REPORT_STAGE).map(key => [key, done[key] || "pending"])), "waiting_for_human");
  try {
    const before = await stageStatuses(sql, run.runId);
    await assert.rejects(() => approveRequestReset(run.runId, { decision: "rerun", actor: "qa" }));
    await assert.rejects(() => approveRequestReset(run.runId, { decision: "skip", actor: "qa" }));
    assert.deepEqual(await stageStatuses(sql, run.runId), before);
    assert.equal((await runState(sql, run.runId)).status, "waiting_for_human");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-7: the route refuses a run that is not paused on a request reset", { skip }, async () => {
  const POST = exported(RESET_ROUTE, "POST");
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const response = await POST(new NextRequest(`http://localhost/api/research-runs/${run.runId}/request-reset`, { method: "POST",
      body: JSON.stringify({ decision: "rerun", actor: "qa" }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: run.runId }) });
    assert.equal(response.status, 422, await response.clone().text());
    const jobs = await sql`SELECT id FROM research_run_jobs WHERE research_run_id = ${run.runId}`;
    assert.equal(jobs.length, 0, "nothing is queued");
    assert.equal((await stageStatuses(sql, run.runId)).historical_record, "completed");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-8: a round after an escalation inherits it, so a needs_sources answer ends unavailable without another search", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  const web = stubWeb();
  const model = scriptModel(packet => {
    if (packet.output_contract === "team_requests") return { requests: packet.previous_requests.length === 1 ? [{ role: "financials",
      question: "Which Reality Labs cost lines are disclosed for each quarter of 2026?", material: true, needs_sources: false, source_role: "regulatory_filing" }] : [] };
    if (packet.output_contract !== "team_answer") return undefined;
    if (packet.request.id === "request-1-1" && packet.source_search_attempted) return unavailable("Still not disclosed after the search.");
    return { status: "needs_sources", answer: "A filing that breaks this out is needed.", evidence_ids: [], artifact_ids: [] };
  });
  try {
    await storeDoc(sql, run, { title: "VHQA 10-K 2025", role: "regulatory_filing",
      content: `Capital Expenditures\n\nCapital expenditures were 12,400, including maintenance and growth projects. Segment costs are reported in total. ${run.runId}` });
    await saveBatch(sql, run, [ask("request-1-1", "valuation", "regulatory_filing", "What maintenance capex is disclosed separately from growth capex?")]);
    await drain(sql, run);
    const first = await getTeamRequests(sql, run.runId);
    assert.equal(first?.state, "answered");
    assert.equal(first!.source_escalated, true);
    assert.equal(first!.requests[0].response?.status, "unavailable");
    assert.equal(model.answers().length, 2, "needs_sources answer, search, one more answer");
    const searchesAfterRound1 = web.searches().length;
    assert.ok(searchesAfterRound1 >= 1);
    await assert.rejects(requestMissingResearch(sql, stageCtx(run)), /investigating report requests/);
    const second = await getTeamRequests(sql, run.runId);
    assert.equal(second?.round, 2);
    assert.equal(second!.source_escalated, true, "carried into round 2");
    await drain(sql, run);
    const final = await getTeamRequests(sql, run.runId);
    assert.equal(final!.requests.find(r => r.id === "request-2-1")?.response?.status, "unavailable");
    assert.equal(web.searches().length, searchesAfterRound1, "no second escalation search");
    const attempts = await sql`SELECT id FROM source_retrieval_attempts WHERE research_run_id = ${run.runId} AND attempt_metadata_json->>'request_id' = 'request-2-1'`;
    assert.equal(attempts.length, 0);
    assert.equal((await stageStatuses(sql, run.runId)).asset_valuation, "completed", "no stage was reset in either round");
  } finally { model.restore(); web.restore(); await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
