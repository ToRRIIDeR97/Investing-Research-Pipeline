import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test, { before, after, describe } from "node:test";
import postgres from "postgres";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "../src/db";
import { POST as createRun } from "../src/app/api/assets/[id]/research-runs/route";
import { POST as queueRun } from "../src/app/api/research-runs/[id]/run-system-pipeline/route";
import { POST as approvePlan } from "../src/app/api/research-runs/[id]/approve-plan/route";
import { POST as requestPlanChanges } from "../src/app/api/research-runs/[id]/request-plan-changes/route";
import { POST as submitReview } from "../src/app/api/research-runs/[id]/review/route";
import {POST as askResearch, GET as loadChat} from '../src/app/api/research-runs/[id]/chat/route';
import {loadReportInputs} from '../src/lib/research/reporting/store';
import { processNextResearchRunJob } from "../src/workers/research-worker";
import { getLatestResearchRunJob, claimNextResearchRun, requeueExpiredResearchRunJobs } from "../src/lib/research/run-queue";
import { callResearchAgent, loadRunContext } from "../src/lib/research/run-context";
import { runResearchPipeline } from "../src/lib/research/pipeline-runner";
import { runSystemResearchPipeline } from "../src/lib/research/system-pipeline";
import { createStagesForRun, approveResearchPlan, advanceStage, resumeResearchRun } from "../src/lib/workflow/orchestrator";
import { createArtifactRepository } from "../src/lib/research/artifacts/repository";
import { evaluateQualityGates } from "../src/lib/workflow/quality-gates";
import { generateMarkdownReport } from "../src/lib/export/report-generator";
import { MockProvider } from "../src/lib/agent-harness/providers/mock";
import { assertModelBudgetAvailable, recordModelCall } from "../src/lib/agents/model-calls";
import { createV3Task } from "../src/lib/research/run-context";
import { getTeamRequests } from "../src/lib/research/team";

function request(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) });
}
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

async function runQueuedJob(runId: string) {
  // Claim only this run's job: the database may hold queued jobs of other runs.
  assert.equal(await processNextResearchRunJob({ runId }), true);
  const job = await getLatestResearchRunJob(runId);
  assert.equal(job?.status, "completed", job?.failure_reason || "Worker should finish its job");
  assert.ok(job?.result_json);
  return job.result_json as { status: string; failure_reason?: string };
}

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

/**
 * Fully delete an asset and all related rows in FK-safe order.
 * Used by test setup/teardown to ensure a clean slate.
 */
async function deleteAssetCascade(sql: ReturnType<typeof postgres>, targetAssetId: string, targetRunId?: string) {
  const runQ = targetRunId
    ? sql`SELECT id FROM research_runs WHERE id = ${targetRunId} AND asset_id = ${targetAssetId}`
    : sql`SELECT id FROM research_runs WHERE asset_id = ${targetAssetId}`;
  const docQ = sql`SELECT id FROM source_documents WHERE asset_id = ${targetAssetId}
    ${targetRunId ? sql`AND research_run_id = ${targetRunId}` : sql``}`;
  const stageQ = sql`SELECT id FROM research_stages WHERE research_run_id IN (${runQ})`;
  const taskQ = sql`SELECT id FROM research_tasks WHERE research_run_id IN (${runQ})`;
  const parseQ = sql`SELECT id FROM document_parses WHERE source_document_id IN (${docQ})`;
  const chunkQ = sql`SELECT id FROM document_chunks WHERE source_document_id IN (${docQ})`;
  const extractQ = sql`SELECT id FROM extracted_tables WHERE source_document_id IN (${docQ})`;
  const locQ = sql`SELECT id FROM source_locations WHERE source_document_id IN (${docQ})`;
  const btQ = sql`SELECT id FROM backtest_runs WHERE research_run_id IN (${runQ})`;
  const vmQ = sql`SELECT id FROM valuation_model_runs WHERE research_run_id IN (${runQ})`;
  const evQ = sql`SELECT id FROM evidence_claims WHERE research_run_id IN (${runQ})`;
  const nbQ = sql`SELECT id FROM notebooks WHERE research_run_id IN (${runQ})`;
  const indQ = sql`SELECT id FROM indicator_definitions WHERE research_run_id IN (${runQ})`;
  const artifactQ = sql`SELECT id FROM research_artifacts WHERE research_run_id IN (${runQ})`;
  const assumptionQ = sql`SELECT id FROM research_assumptions WHERE research_run_id IN (${runQ})`;

  // Phase 1: deepest leaf tables
  await sql`DELETE FROM thesis_drivers WHERE thesis_id IN (SELECT id FROM theses WHERE research_run_id IN (${runQ}))`;
  await sql`DELETE FROM research_artifact_claim_links WHERE artifact_id IN (${artifactQ})`;
  await sql`DELETE FROM research_artifact_dependencies WHERE artifact_id IN (${artifactQ})`;
  await sql`DELETE FROM research_assumption_claim_links WHERE assumption_id IN (${assumptionQ})`;
  await sql`DELETE FROM indicator_observations WHERE indicator_definition_id IN (${indQ})`;
  await sql`DELETE FROM metric_observation_inputs WHERE metric_observation_id IN (SELECT id FROM metric_observations WHERE research_run_id IN (${runQ}))`;
  await sql`DELETE FROM valuation_artifacts WHERE valuation_model_run_id IN (${vmQ})`;
  await sql`DELETE FROM claim_relationships WHERE from_claim_id IN (${evQ}) OR to_claim_id IN (${evQ})`;
  await sql`DELETE FROM document_embeddings WHERE document_chunk_id IN (${chunkQ})`;
  await sql`DELETE FROM task_dependencies WHERE task_id IN (${taskQ}) OR depends_on_task_id IN (${taskQ})`;
  await sql`DELETE FROM note_links WHERE note_block_id IN (SELECT id FROM note_blocks WHERE notebook_id IN (${nbQ}))`;
  await sql`DELETE FROM note_blocks WHERE notebook_id IN (${nbQ})`;
  await sql`DELETE FROM evidence_links WHERE evidence_claim_id IN (${evQ})`;

  // Phase 2: source_docs / runs dependents
  await sql`DELETE FROM source_role_assignments WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM source_document_metadata WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM source_document_relations WHERE parent_source_document_id IN (${docQ}) OR child_source_document_id IN (${docQ})`;
  await sql`DELETE FROM source_retrieval_attempts WHERE research_run_id IN (${runQ})`;

  // Phase 3: agent/execution infrastructure
  await sql`DELETE FROM agent_output_staging WHERE task_id IN (${taskQ})`;
  await sql`DELETE FROM agent_traces WHERE task_id IN (${taskQ})`;
  await sql`DELETE FROM stage_validation_results WHERE stage_id IN (${stageQ})`;
  await sql`DELETE FROM model_budget_ledger WHERE stage_id IN (${stageQ})`;
  await sql`DELETE FROM model_call_logs WHERE stage_id IN (${stageQ})`;

  // Phase 4: mid-layer tables
  await sql`DELETE FROM strategy_combinations WHERE backtest_run_id IN (${btQ})`;
  await sql`DELETE FROM backtest_artifacts WHERE backtest_run_id IN (${btQ})`;
  await sql`DELETE FROM scenarios WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM scenarios WHERE valuation_model_run_id IN (${vmQ})`;
  await sql`DELETE FROM analysis_sections WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM indicator_definitions WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM exports WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM notebooks WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM source_role_coverage WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_run_sources WHERE research_run_id IN (${runQ})`;

  // Phase 5: document content layer
  await sql`DELETE FROM source_locations WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM document_chunks WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM extracted_tables WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM document_parses WHERE source_document_id IN (${docQ})`;

  // Phase 6: core entity tables
  await sql`DELETE FROM metric_observations WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM valuation_signals WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM evidence_claims WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM theses WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM risks WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM catalysts WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM backtest_runs WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM valuation_model_runs WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_assumptions WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_artifacts WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM source_documents WHERE id IN (${docQ})`;
  await sql`DELETE FROM source_gaps WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM review_decisions WHERE research_run_id IN (${runQ})`;

  // Phase 7: infrastructure
  await sql`DELETE FROM research_run_jobs WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_tasks WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_stages WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM asset_profile_assignments WHERE ${targetRunId ? sql`research_run_id IN (${runQ})` : sql`asset_id = ${targetAssetId}`}`;
  await sql`DELETE FROM research_runs WHERE ${targetRunId ? sql`id IN (${runQ})` : sql`asset_id = ${targetAssetId}`}`;

  // Phase 8: asset hierarchy
  if (targetRunId) return;
  await sql`DELETE FROM listings WHERE instrument_id IN (SELECT id FROM instruments WHERE asset_id = ${targetAssetId})`;
  await sql`DELETE FROM asset_entities WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM asset_classifications WHERE asset_id = ${targetAssetId}`;
  // Source discovery syncs price history against the asset's instrument.
  for (const table of ["market_price_bars", "corporate_actions", "market_data_fetches"]) {
    await sql`DELETE FROM ${sql(table)} WHERE instrument_id IN (SELECT id FROM instruments WHERE asset_id = ${targetAssetId})`;
  }
  await sql`DELETE FROM instruments WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM assets WHERE id = ${targetAssetId}`;
}

describe("SOFI Research End-to-End Acceptance (Component 9)", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, () => {
  loadLocalEnv();
  const sql = postgres(process.env.DATABASE_URL!);
  
  // Unique test asset IDs for isolation (C9-T2: Never mutate real SOFI asset)
  const testAssetId = crypto.randomUUID();
  const testInstrumentId = crypto.randomUUID();
  const testSlug = `sofi-e2e-${testAssetId.slice(0, 8)}`;
  let financialsProfileId: string;
  let preExistingSofiId: string | null = null;
  let preExistingSofiCreatedAt: string | null = null;

  before(async () => {
    // 1. Get seeded profile
    const profileRows = await sql`
      SELECT id FROM research_profiles WHERE profile_key = 'financials' LIMIT 1
    `;
    assert.ok(profileRows.length > 0, "financials profile must be seeded");
    financialsProfileId = profileRows[0].id;

    // 2. Ensure pre-existing real SOFI asset exists (C9-T2 safety check seed)
    const existingSofi = await sql`SELECT id, created_at FROM assets WHERE slug = 'sofi' LIMIT 1`;
    if (existingSofi.length > 0) {
      preExistingSofiId = existingSofi[0].id;
      preExistingSofiCreatedAt = String(existingSofi[0].created_at);
    } else {
      preExistingSofiId = crypto.randomUUID();
      const preInstId = crypto.randomUUID();
      await sql`
        INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
        VALUES (${preExistingSofiId}, 'Pre-existing SoFi', 'sofi', ${financialsProfileId}, 'active', 'equity', 'USD')
      `;
      await sql`
        INSERT INTO instruments (id, asset_id, name, instrument_type)
        VALUES (${preInstId}, ${preExistingSofiId}, 'Pre-existing SoFi common', 'equity')
      `;
      await sql`
        INSERT INTO listings (id, instrument_id, exchange, symbol, is_primary)
        VALUES (${crypto.randomUUID()}, ${preInstId}, 'NASDAQ', 'SOFI', true)
      `;
      const created = await sql`SELECT created_at FROM assets WHERE id = ${preExistingSofiId}`;
      preExistingSofiCreatedAt = String(created[0].created_at);
    }

    // 3. Insert isolated test asset for this acceptance suite
    await sql`
      INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
      VALUES (${testAssetId}, 'SoFi Technologies, Inc. (Test)', ${testSlug}, ${financialsProfileId}, 'active', 'equity', 'USD')
    `;
    await sql`
      INSERT INTO instruments (id, asset_id, name, instrument_type)
      VALUES (${testInstrumentId}, ${testAssetId}, 'SoFi common stock (Test)', 'equity')
    `;
    await sql`
      INSERT INTO listings (id, instrument_id, exchange, symbol, is_primary)
      VALUES (${crypto.randomUUID()}, ${testInstrumentId}, 'NASDAQ', ${`SOFI_TEST_${testAssetId.slice(0, 4)}`}, true)
    `;
  });

  after(async () => {
    // Teardown test asset
    await deleteAssetCascade(sql, testAssetId);

    // C9-T2 assertion: assert pre-existing SOFI asset still exists untouched
    if (preExistingSofiId) {
      const checkPre = await sql`SELECT id, created_at FROM assets WHERE id = ${preExistingSofiId}`;
      assert.equal(checkPre.length, 1, "Pre-existing SOFI asset must not be deleted by tests");
      assert.equal(String(checkPre[0].created_at), preExistingSofiCreatedAt, "Pre-existing SOFI asset must not be mutated by tests");
    }

    await sql.end();
    await db.$client.end();
  });

  test("C9-T1: Full research flow through all three pipeline invocations and gates", async () => {
    const cutoffAt = "2026-01-01T00:00:00.000Z";
    const created = await createRun(request({
      run_type: "deep_dive", research_question: "Mock SOFI Deep Dive?",
      requested_by: "system-test-harness", budget_limit_usd: 100,
      source_cutoff_at: cutoffAt, market_data_cutoff_at: cutoffAt,
    }), paramsFor(testAssetId));
    assert.equal(created.status, 201);
    const { id: runId } = await created.json();
    assert.ok(runId);
    const queued = await queueRun(request(), paramsFor(runId));
    assert.equal(queued.status, 202);
    const firstJob = await queued.json();
    const duplicate = await queueRun(request(), paramsFor(runId));
    assert.equal((await duplicate.json()).jobId, firstJob.jobId, "Queue requests are idempotent");

    // Simulate a worker dying after claiming; only the expired lease may be reclaimed.
    const claimed = await claimNextResearchRun("expired-test-worker", undefined, { runId });
    assert.equal(claimed?.id, firstJob.jobId);
    assert.equal(await claimNextResearchRun("other-test-worker", undefined, { runId }), null);
    await sql`UPDATE research_run_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = ${firstJob.jobId}`;
    const recovered = await requeueExpiredResearchRunJobs();
    assert.ok(recovered.some((job) => job.id === firstJob.jobId && job.status === "queued"));

    // ==========================================
    // Invocation 1: Reach research-plan gate
    // ==========================================
    let state = await runQueuedJob(runId);
    assert.equal(state.status, "waiting_for_human");

    const [planStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
    `;
    assert.equal(planStage?.status, "waiting_for_human");
    const [persistedPlan] = await sql`
      SELECT id, content_json FROM research_artifacts
      WHERE research_run_id = ${runId} AND artifact_type = 'research_plan'
        AND status IN ('validated', 'accepted')
    `;
    assert.ok(persistedPlan, "Research plan must exist before approval");
    assert.deepEqual(persistedPlan.content_json.composed_archetypes, ["bank", "lender"]);
    assert.equal(persistedPlan.content_json.required_historical_metrics.some((item: any) => item.metric_family === "gmv"), false);

    // Zero non-human running work
    const runningTasks1 = await sql`SELECT id FROM research_tasks WHERE research_run_id = ${runId} AND status = 'running'`;
    assert.equal(runningTasks1.length, 0);

    // ==========================================
    // Gate 1 Approval: Approve Research Plan
    // ==========================================
    // Plan feedback redrafts the framing: the plan stage reopens, the job reruns it, and the gate opens on version 2.
    assert.ok(persistedPlan.content_json.framing?.central_question, "the plan carries a drafted framing");
    const changes = await requestPlanChanges(request({ notes: "Value the lending engine separately from the tech platform.", requested_by: "system-test-harness" }), paramsFor(runId));
    assert.equal(changes.status, 200);
    assert.equal((await changes.json()).status, "redraft_queued");
    state = await runQueuedJob(runId);
    assert.equal(state.status, "waiting_for_human");
    const [redrafted] = await sql`SELECT artifact_version, content_json FROM research_artifacts WHERE research_run_id = ${runId}
      AND artifact_type = 'research_plan' AND status = 'validated' ORDER BY artifact_version DESC LIMIT 1`;
    assert.equal(redrafted.artifact_version, 2);
    assert.match(redrafted.content_json.framing.decisive_insight_hypothesis, /lending engine separately/);
    assert.equal(redrafted.content_json.plan_feedback.length, 1);
    const editedFraming = { ...redrafted.content_json.framing, central_question: "Does the lending engine earn above its cost of funding through a credit cycle?" };
    const planApproval = await approvePlan(request({ approved_by: "system-test-harness", framing: editedFraming }), paramsFor(runId));
    assert.equal(planApproval.status, 200);
    assert.equal((await planApproval.json()).success, true);
    const [approvedRun] = await sql`SELECT metadata_json->'research_framing' AS framing FROM research_runs WHERE id = ${runId}`;
    assert.equal(approvedRun.framing.central_question, editedFraming.central_question, "the approved framing is the reviewer's edit");
    const [edited] = await sql`SELECT artifact_version, status, content_json->>'framing_source' AS source FROM research_artifacts WHERE research_run_id = ${runId}
      AND artifact_type = 'research_plan' ORDER BY artifact_version DESC LIMIT 1`;
    assert.deepEqual([edited.artifact_version, edited.status, edited.source], [3, "accepted", "reviewer"]);

    // ==========================================
    // Invocation 2: Execute research through decision synthesis & AI review to human_review gate
    // ==========================================
    state = await runQueuedJob(runId);
    if (state.status !== "waiting_for_human") {
      const failed = await sql`
        SELECT stage_key, status, failure_reason FROM research_stages
        WHERE research_run_id = ${runId} AND status IN ('failed', 'needs_more_work')
        ORDER BY stage_order
      `;
      assert.fail(`Expected final review gate, got ${state.status}: ${JSON.stringify(failed)}`);
    }
    // The approved framing rides in every analysis packet except deterministic normalization and the framing call.
    const unframed = await sql`SELECT DISTINCT task_type FROM research_tasks WHERE research_run_id = ${runId} AND input_json ? 'packet'
      AND task_type IN ('moat_analysis', 'business_process_analysis', 'management_assessment', 'operating_model', 'decision_synthesis', 'report_outline')
      AND NOT (input_json->'packet' ? 'research_framing')`;
    assert.deepEqual(unframed.map((r) => r.task_type), [], "analysis packets without research_framing");
    const [framedCalls] = await sql`SELECT count(*)::int AS n FROM research_tasks WHERE research_run_id = ${runId}
      AND input_json->'packet'->'research_framing'->>'central_question' = ${editedFraming.central_question}`;
    assert.ok(framedCalls.n >= 5, `the approved framing reached ${framedCalls.n} calls`);
    const [management] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = 'management_assessment'`;
    assert.equal(management?.content_json.axes.length, 5, "management is scored on five axes");

    const [finalStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'human_review'
    `;
    assert.equal(finalStage?.status, "waiting_for_human");

    // Framework backtest executed 50 thesis-distinct combinations
    const backtestStages = await sql`
      SELECT stage_key, status FROM research_stages
      WHERE research_run_id = ${runId}
        AND stage_key IN ('indicator_design', 'strategy_design', 'backtest_execution', 'backtest_review')
    `;
    assert.equal(backtestStages.length, 4);
    assert.ok(backtestStages.every((s) => s.status === "completed"));

    const [backtestCount] = await sql`
      SELECT COUNT(*) AS count FROM backtest_runs WHERE research_run_id = ${runId} AND status = 'completed'
    `;
    assert.equal(Number(backtestCount.count), 50);

    // Query persisted artifacts
    const artifacts = await sql`
      SELECT artifact_type, status, content_json FROM research_artifacts WHERE research_run_id = ${runId}
    `;
    assert.ok(artifacts.length > 0);

    const artifactTypes = artifacts.map((a) => a.artifact_type);
    const expectedTypes = [
      "company_genesis", "founder_profile", "strategic_history_timeline", "strategic_dna",
      "historical_diagnosis", "segment_model", "customer_decision_map", "business_process_map",
      "bottleneck_register", "competitive_response_matrix", "moat_assessment", "moat_attack_matrix",
      "no_moat_counterfactual", "driver_tree", "operating_model", "top_down_bottom_up_reconciliation", "reinvestment_model", "operating_scenario_set",
      "valuation_scenario_set", "reverse_valuation", "annual_price_target_path", "investment_thesis",
      "risk_register", "catalyst_register", "expected_return_matrix", "thesis_breakers",
      "monitoring_dashboard", "confidence_assessment", "decision_record"
    ];

    for (const type of expectedTypes) {
      assert.ok(artifactTypes.includes(type), `Missing expected artifact in registry: ${type}`);
    }

    const researchPlan = artifacts.find((a) => a.artifact_type === "research_plan")?.content_json as any;
    const roleCoverage = await sql`
      SELECT source_role, artifact_type FROM source_role_coverage WHERE research_run_id = ${runId}
    `;
    const allowedCoverage = new Set((researchPlan.required_source_roles || []).flatMap((role: any) =>
      (role.blockedArtifacts || []).map((artifact: string) => `${role.role}:${artifact}`)
    ));
    assert.ok(roleCoverage.length > 0, "source roles must have covered artifacts");
    assert.ok(roleCoverage.every((row) => allowedCoverage.has(`${row.source_role}:${row.artifact_type}`)));

    const operatingModel = artifacts.find((a) => a.artifact_type === "operating_model")?.content_json as any;
    const reinvestmentModel = artifacts.find((a) => a.artifact_type === "reinvestment_model")?.content_json as any;
    const scenarioSet = artifacts.find((a) => a.artifact_type === "operating_scenario_set")?.content_json as any;
    const baseStatements = scenarioSet.scenarios.find((scenario: any) => scenario.scenario_type === "base")?.resulting_financial_statements_json;
    assert.equal(baseStatements.consolidated_revenue, operatingModel.consolidated_revenue);
    assert.equal(baseStatements.consolidated_operating_income, operatingModel.consolidated_operating_income);
    assert.deepEqual(baseStatements.working_capital_forecast, reinvestmentModel.working_capital_forecast);
    assert.deepEqual(baseStatements.segment_revenue, Object.fromEntries(
      operatingModel.segments.map((segment: any) => [segment.segment_name, segment.forecast_revenue])
    ));
    assert.deepEqual(baseStatements.segment_operating_income, Object.fromEntries(
      operatingModel.segments.map((segment: any) => [segment.segment_name, segment.forecast_operating_income])
    ));

    // ==========================================
    // Annual Price Target Acceptance Table Validation
    // ==========================================
    const pathArtifact = artifacts.find((a) => a.artifact_type === "annual_price_target_path");
    assert.ok(pathArtifact, "annual_price_target_path artifact must exist");
    const pathContent = pathArtifact.content_json as any;
    assert.ok(Array.isArray(pathContent.price_target_path), "price_target_path must be an array");

    const targets: Array<{ fiscal_year: number; scenario_type: string; price_target: number; currency: string }> = pathContent.price_target_path;
    
    // Check years range 2026..2030 and scenarios bear/base/bull
    const years = [2026, 2027, 2028, 2029, 2030];
    const scenariosList = ["bear", "base", "bull"];
    const seenPairs = new Set<string>();

    for (const yr of years) {
      for (const sc of scenariosList) {
        const pairKey = `${yr}:${sc}`;
        assert.ok(!seenPairs.has(pairKey), `Duplicate (fiscal_year, scenario_type) pair found: ${pairKey}`);
        seenPairs.add(pairKey);

        const target = targets.find((t) => t.fiscal_year === yr && t.scenario_type === sc);
        assert.ok(target, `Missing required target for year ${yr}, scenario ${sc}`);
        assert.ok(Number.isFinite(target.price_target) && target.price_target > 0, `Price target for ${pairKey} must be finite positive`);
        assert.equal(target.currency || "USD", "USD", `Currency for ${pairKey} must be USD`);
      }
    }

    // AI reviewer completed
    const [reviewStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'ai_reviewer'
    `;
    assert.equal(reviewStage?.status, "completed");

    // The first live request must include the contract, not discover it in a repair.
    const [operatingTask] = await sql`SELECT input_json FROM research_tasks
      WHERE research_run_id = ${runId} AND task_type = 'operating_model' ORDER BY started_at DESC LIMIT 1`;
    const operatingPacket = operatingTask.input_json.packet;
    assert.ok(Object.keys(operatingPacket.recent_reported_history).length > 0);
    assert.ok(operatingPacket.team_context.upstream_artifacts.some((a: any) => a.artifact_type === 'historical_diagnosis'));
    assert.ok(!operatingPacket.team_context.upstream_artifacts.some((a: any) => a.artifact_type === 'historical_record'),
      'Specialists must not receive the complete archive again alongside their tailored historical inputs');
    const reportTasks = await sql`SELECT input_json FROM research_tasks
      WHERE research_run_id = ${runId} AND task_key LIKE 'report:%'`;
    assert.ok(reportTasks.length >= 3);
    for (const task of reportTasks) {
      const request = task.input_json;
      assert.deepEqual(request.packet.output_schema, request.output_format.schema,
        `Missing first-attempt schema for ${request.packet.output_contract}`);
      // The prompt ended with this exact packet, so the row stores the packet once plus the prompt's instructions.
      assert.equal(request.prompt, undefined);
      assert.match(request.prompt_instructions, /Return exactly one JSON object/);
      assert.match(request.prompt_sha256, /^[0-9a-f]{64}$/);
      const sentPacket = request.packet;
      assert.deepEqual(sentPacket.output_schema, request.output_format.schema);
      if (sentPacket.output_contract === "report_review") {
        assert.equal("markdown" in sentPacket.report_document, false, "Review must not duplicate rendered tables and source passages");
        assert.equal("artifacts" in sentPacket.report_document, false);
        assert.equal("evidence" in sentPacket.report_document, false);
        assert.ok(sentPacket.artifacts.length > 0);
        assert.ok(sentPacket.report_document.sections.length > 0);
      }
    }

    // Zero running non-human work
    const runningStages2 = await sql`SELECT id FROM research_stages WHERE research_run_id = ${runId} AND status = 'running'`;
    assert.equal(runningStages2.length, 0);

    // Synthetic data is never investment_ready
    const [runData] = await sql`SELECT * FROM research_runs WHERE id = ${runId}`;
    const sources = await sql`SELECT * FROM source_documents WHERE research_run_id = ${runId}`;
    const evidence = await sql`SELECT * FROM evidence_claims WHERE research_run_id = ${runId}`;
    const metrics = await sql`SELECT * FROM metric_observations WHERE research_run_id = ${runId}`;
    const signals = await sql`SELECT * FROM valuation_signals WHERE research_run_id = ${runId}`;
    const scenarios = await sql`SELECT * FROM scenarios WHERE research_run_id = ${runId}`;
    const reviewDecisions = await sql`SELECT * FROM review_decisions WHERE research_run_id = ${runId}`;

    const qualityGateResult = evaluateQualityGates({
      run: runData, sources, evidence, metrics, signals, scenarios, artifacts, reviewDecisions
    });
    assert.notEqual(qualityGateResult.actionReadiness, "investment_ready");

    // ==========================================
    // Gate 2 Approval: Persist decision & approve Human Review
    // ==========================================
    let [draft] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
      AND artifact_type = 'report_document' AND status = 'validated' ORDER BY artifact_version DESC LIMIT 1`;
    assert.ok(draft?.content_json?.content_hash, "report must exist before human approval");
    const inputsBeforeChat=await loadReportInputs(sql,runId,cutoffAt);
    const reply=await askResearch(request({message:'What drives the base-case valuation?'}),paramsFor(runId));
    assert.equal(reply.status,200,JSON.stringify(await reply.clone().json()));
    const conversation=await reply.json();assert.equal(conversation.messages.length,2);
    const chat=await loadChat(new NextRequest('http://localhost/api/test'),paramsFor(runId));
    assert.equal((await chat.json()).messages.length,2);
    assert.equal((await loadReportInputs(sql,runId,cutoffAt)).input_hash,inputsBeforeChat.input_hash,'Chat must not change report inputs or invalidate approval');
    const maliciousOrigin=new NextRequest('http://localhost/api/test',{method:'POST',headers:{origin:'https://unrelated.example'},body:JSON.stringify({message:'Test'})});
    assert.equal((await askResearch(maliciousOrigin,paramsFor(runId))).status,403);
    const methods=artifacts.find(a=>a.artifact_type==='valuation_scenario_set')!.content_json.method_schedules;
    assert.equal(methods.length,3);assert.ok(methods.every((m:any)=>Number.isFinite(m.value_per_share)));
    assert.equal(draft.content_json.sections.filter((s:any)=>s.coverage.includes('valuation')).length,1);
    assert.ok(!draft.content_json.sections.some((s:any)=>s.coverage.every((k:string)=>['history','evidence'].includes(k))));
    const staleReview = await submitReview(request({ status: "approved_for_tracking", reportHash: "stale", reviewed_by: "human-reviewer-1" }), paramsFor(runId));
    assert.equal(staleReview.status, 409, "stale report approval must be rejected");
    const firstHash = draft.content_json.content_hash;
    const revision = await submitReview(request({ status: "needs_more_work", reportHash: firstHash,
      open_questions: "Explain capital spending versus returns on that spending.", reviewed_by: "human-reviewer-1" }), paramsFor(runId));
    assert.equal(revision.status, 201);
    assert.equal((await revision.json()).workflow.status, "revision_queued");
    assert.equal((await runQueuedJob(runId)).status, "waiting_for_human", "revision must return to the human gate");
    [draft] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
      AND artifact_type = 'report_document' AND status = 'validated' ORDER BY artifact_version DESC LIMIT 1`;
    assert.notEqual(draft.content_json.content_hash, firstHash, "a substantive revision changes the report hash");
    const [oldVersion] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
      AND artifact_type = 'report_document' AND content_json->>'content_hash' = ${firstHash}`;
    assert.equal(oldVersion.content_json.content_hash, firstHash, "prior report text remains available");
    // The gate reads the stored review: a confirmed blocking finding stops a position, and an open high finding
    // must be acknowledged before either approval. report_review is not a report input, so the hash stays valid.
    const currentHash = draft.content_json.content_hash;
    await sql`UPDATE research_artifacts SET content_json = content_json || ${sql.json({ effective_verdict: "needs_more_work",
      findings: [{ section_id: "valuation", category: "calculation", severity: "high", issue: "Terminal value exceeds enterprise value." }],
      blocking: [{ reason: "High calculation finding confirmed by code: terminal value share above 85%." }] })}
      WHERE research_run_id = ${runId} AND artifact_type = 'report_review' AND content_json->>'report_hash' = ${currentHash}`;
    const blockedPosition = await submitReview(request({ status: "approved_for_position", reviewed_by: "human-reviewer-1",
      reportHash: currentHash, acknowledgeFindings: true }), paramsFor(runId));
    assert.equal(blockedPosition.status, 422);
    assert.equal((await blockedPosition.json()).code, "REVIEW_BLOCKS_POSITION");
    const unacknowledged = await submitReview(request({ status: "approved_for_tracking", reviewed_by: "human-reviewer-1", reportHash: currentHash }), paramsFor(runId));
    assert.equal(unacknowledged.status, 422);
    assert.equal((await unacknowledged.json()).code, "FINDINGS_NOT_ACKNOWLEDGED");
    const reviewResponse = await submitReview(request({
      status: "approved_for_tracking", reviewed_by: "human-reviewer-1",
      reportHash: draft.content_json.content_hash, acknowledgeFindings: true,
      rubricRatings: { framing: 2, valuation: 1 },
    }), paramsFor(runId));
    assert.equal(reviewResponse.status, 201);
    assert.equal((await reviewResponse.json()).workflow.success, true);
    const [rated] = await sql`SELECT metadata_json->'review_rubric' AS rubric FROM research_runs WHERE id = ${runId}`;
    assert.deepEqual([rated.rubric.ratings, rated.rubric.report_hash], [{ framing: 2, valuation: 1 }, currentHash], "ratings stored with the report version they judged");

    // ==========================================
    // Invocation 3: Execute terminal export and refresh_schedule stages
    // ==========================================
    state = await runQueuedJob(runId);
    const [completion] = await sql`SELECT metadata_json->'quality_gate' AS quality FROM research_runs WHERE id = ${runId}`;
    assert.equal(state.status, "completed", JSON.stringify(completion.quality));

    const [exportStage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'export'`;
    assert.equal(exportStage?.status, "completed");

    const [refreshStage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'refresh_schedule'`;
    assert.equal(refreshStage?.status, "completed");

    // Check synthetic report artifact created
    const [syntheticArtifact] = await sql`
      SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = 'synthetic_report'
    `;
    assert.ok(syntheticArtifact, "synthetic_report artifact must be created by export handler");
    const report = readFileSync(syntheticArtifact.content_json.storagePath, "utf8");
    assert.equal(report, draft.content_json.markdown, "export must reproduce the report approved by the human");
    assert.equal(syntheticArtifact.content_json.humanDecision, "approved_for_tracking", "export metadata must retain the human decision");
    assert.ok(!report.includes("[object Object]"), "export must render typed artifacts as readable text");

    const [refreshArtifact] = await sql`
      SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = 'refresh_schedule'
    `;
    assert.ok(refreshArtifact, "refresh_schedule artifact must be created by refresh handler");

    // Artifact lifecycle: one current version per type and scope; the human gates accept what they approved.
    const current = await sql`SELECT artifact_type, scope_key, status FROM research_artifacts
      WHERE research_run_id = ${runId} AND status <> 'superseded'`;
    const keys = current.map((r) => `${r.artifact_type}:${r.scope_key}`);
    assert.equal(new Set(keys).size, keys.length, "each artifact type and scope has one current version");
    const statuses = (type: string) => current.filter((r) => r.artifact_type === type).map((r) => r.status);
    assert.deepEqual(statuses("research_plan"), ["accepted"], "the plan gate accepts the research plan");
    assert.deepEqual(statuses("report_document"), ["accepted"], "the final gate accepts the approved report");
    assert.deepEqual(statuses("valuation_scenario_set"), ["accepted"], "the final gate accepts the report inputs");
    assert.deepEqual([...new Set(current.filter((r) => r.status === "validated").map((r) => r.artifact_type))].sort(),
      ["refresh_schedule", "synthetic_report"], "only products written after the final gate stay validated");

    // Clean up run in FK-safe order without deleting the shared test asset.
    await deleteAssetCascade(sql, testAssetId, runId);
  });

  test("four specialist plans overlap and report requests escalate to collection and return to review", { timeout: 120_000 }, async () => {
    const created = await createRun(request({ run_type: "deep_dive", budget_limit_usd: 100, research_question: "Which disclosed cash flows support the valuation?",
      source_cutoff_at: "2026-01-01T00:00:00.000Z", market_data_cutoff_at: "2026-01-01T00:00:00.000Z" }), paramsFor(testAssetId));
    const { id: runId } = await created.json();
    const original = MockProvider.prototype.stream;
    let briefCount = 0;
    let interrupted = false;
    let release!: () => void;
    const allBriefsStarted = new Promise<void>(resolve => { release = resolve; });
    MockProvider.prototype.stream = async function* (req, signal) {
      const packet = JSON.parse(req.prompt.slice(req.prompt.lastIndexOf("Task packet:") + 12).trim());
      if (packet.output_contract === "team_brief") {
        briefCount++;
        if (briefCount === 4) release();
        await allBriefsStarted;
      }
      let response;
      if (packet.output_contract === "team_requests" && !packet.previous_requests.length) {
        response = { requests: [{ role: "valuation", question: "What maintenance capex is disclosed separately from growth capex?",
          material: true, needs_sources: false, source_role: "regulatory_filing" }] };
      } else if (packet.output_contract === "team_answer") {
        if (!interrupted) { interrupted = true; throw new Error("Simulated interrupted specialist answer"); }
        response = { status: packet.source_search_attempted ? "unavailable" : "needs_sources",
          answer: "Maintenance capex is not disclosed separately in the available documents.", evidence_ids: [], artifact_ids: [] };
      }
      if (response) {
        yield { type: "response.started", requestId: "team-test" };
        yield { type: "text.delta", text: JSON.stringify(response) };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
        yield { type: "response.completed" };
      } else yield* original.call(this, req, signal);
    };
    try {
      const initial = await runResearchPipeline(runId);
      assert.equal(initial.status, "waiting_for_human", initial.failure_reason || initial.notes.join("\n"));
      assert.equal(briefCount, 0, "specialists must not start before plan approval");
      await approveResearchPlan(runId, "team-test");
      const interruptedRun = await runResearchPipeline(runId);
      assert.equal(interruptedRun.status, "needs_more_work");
      assert.match(interruptedRun.failure_reason || "", /Simulated interrupted specialist/);
      assert.equal((await getTeamRequests(sql, runId))?.state, "processing");
      await resumeResearchRun(runId);
      const result = await runResearchPipeline(runId);
      assert.equal(result.status, "waiting_for_human", result.failure_reason || result.notes.join("\n"));
      assert.equal(briefCount, 4, "all four specialist roles actually entered concurrent model calls");
      const batch = await getTeamRequests(sql, runId);
      assert.equal(batch?.state, "answered");
      assert.equal(batch?.source_escalated, true);
      assert.equal(batch?.requests[0].response?.status, "unavailable");
      const attempts = await sql`SELECT id FROM source_retrieval_attempts WHERE research_run_id = ${runId}
        AND attempt_metadata_json->>'request_id' = ${batch!.requests[0].id}`;
      assert.equal(attempts.length, 1, "specialist's missing evidence was routed back to the collector");
      const [report] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
        AND artifact_type = 'report_document' AND status = 'validated'`;
      assert.equal(report.content_json.conclusion_status, "withheld");
      const callsBeforeResume = await sql`SELECT id FROM model_call_logs WHERE research_run_id = ${runId}`;
      assert.equal((await runResearchPipeline(runId)).status, "waiting_for_human");
      const callsAfterResume = await sql`SELECT id FROM model_call_logs WHERE research_run_id = ${runId}`;
      assert.equal(callsAfterResume.length, callsBeforeResume.length, "restarting at a gate does not repeat specialist work");
      const [exportStage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'export'`;
      assert.equal(exportStage.status, "pending");
    } finally {
      release();
      MockProvider.prototype.stream = original;
      await deleteAssetCascade(sql, testAssetId, runId);
    }
  });

  test("specialists plan only after discovery, and a specialist's document request pauses and reruns only its stage", { timeout: 120_000 }, async () => {
    const created = await createRun(request({ run_type: "deep_dive", budget_limit_usd: 100, research_question: "How durable is the lending moat?",
      source_cutoff_at: "2026-01-01T00:00:00.000Z", market_data_cutoff_at: "2026-01-01T00:00:00.000Z" }), paramsFor(testAssetId));
    const { id: runId } = await created.json();
    const original = MockProvider.prototype.stream;
    const discoveryAtBrief: string[] = [];
    const moatPackets: any[] = [];
    const peerQuery = "Upstart Holdings 2025 annual report 10-K";
    MockProvider.prototype.stream = async function* (req, signal) {
      const packet = JSON.parse(req.prompt.slice(req.prompt.lastIndexOf("Task packet:") + 12).trim());
      if (packet.output_contract === "team_brief") {
        const [stage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'source_discovery'`;
        discoveryAtBrief.push(stage.status);
      }
      if (packet.output_contract !== "moat_analysis") { yield* original.call(this, req, signal); return; }
      moatPackets.push(packet);
      let text = "";
      for await (const event of original.call(this, req, signal)) if (event.type === "text.delta") text += event.text;
      const output = JSON.parse(text);
      if (moatPackets.length === 1) output.source_requests = [{ source_role: "peer_company_primary", query: peerQuery, reason: "Compare origination economics with a named lending peer" }];
      yield { type: "response.started", requestId: "source-request-test" };
      yield { type: "text.delta", text: JSON.stringify(output) };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      yield { type: "response.completed" };
    };
    try {
      assert.equal((await runResearchPipeline(runId)).status, "waiting_for_human");
      // A role gap written by the pre-collector discovery must not block the replayed stage.
      await sql`INSERT INTO source_gaps (asset_id, research_run_id, gap_key, description, severity, status, owner)
        VALUES (${testAssetId}, ${runId}, 'system_source_reader_required_source_role_peer_company_primary_is_not_covered_by_any_',
          'Required source role ''peer_company_primary'' is not covered by any fetched documents', 'high', 'open', 'system:source-reader')`;
      await approveResearchPlan(runId, "source-request-test");
      const result = await runResearchPipeline(runId);
      assert.equal(result.status, "waiting_for_human", result.failure_reason || result.notes.join("\n"));
      assert.ok(discoveryAtBrief.length > 0 && discoveryAtBrief.every(status => status === "completed"), "briefs start only after the collector finishes");
      const [review] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
        AND artifact_type = 'source_review' AND status = 'validated'`;
      assert.equal(review.content_json.sufficient, true);
      assert.ok(result.notes.some(note => /moat_analysis is waiting for requested sources/.test(note)));
      const [ledger] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
        AND artifact_type = 'source_requests' AND scope_key = 'moat_analysis' AND status = 'validated'`;
      assert.equal(ledger.content_json.rounds.length, 1);
      assert.equal(ledger.content_json.rounds[0].state, "fetched");
      assert.equal(ledger.content_json.rounds[0].requests[0].query, peerQuery);
      // The mock collector fetches nothing, so the specialist reruns knowing the search came back empty.
      assert.equal(ledger.content_json.rounds[0].requests[0].status, "unavailable");
      assert.equal(moatPackets.length, 2);
      assert.equal(moatPackets[1].team_context.source_requests.previous[0].status, "unavailable");
      const [attempt] = await sql`SELECT attempt_metadata_json FROM source_retrieval_attempts WHERE research_run_id = ${runId}
        AND attempt_metadata_json->>'query' = ${peerQuery}`;
      assert.equal(attempt.attempt_metadata_json.requested_by, "business:moat_analysis");
      const legacy = await sql`SELECT status FROM source_gaps WHERE research_run_id = ${runId} AND owner = 'system:source-reader'
        AND description LIKE 'Required source role%'`;
      assert.deepEqual(legacy.map(gap => gap.status), ["resolved"]);
      const roleGaps = await sql`SELECT gap_key, severity FROM source_gaps WHERE research_run_id = ${runId}
        AND owner = 'system:source-collector' AND status = 'open'`;
      assert.ok(roleGaps.every(gap => gap.gap_key.startsWith("missing_") && gap.severity === "medium"));
      const [moat] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'moat_analysis'`;
      assert.equal(moat.status, "completed");
      const [reviewStage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'human_review'`;
      assert.equal(reviewStage.status, "waiting_for_human");
    } finally {
      MockProvider.prototype.stream = original;
      await deleteAssetCascade(sql, testAssetId, runId);
    }
  });

  test("concurrent calls reserve shared budget and record spend above estimates", async () => {
    const created = await createRun(request({ run_type: "deep_dive", budget_limit_usd: 0.15 }), paramsFor(testAssetId));
    const { id: runId } = await created.json();
    try {
      const tasks = await Promise.all(["a", "b"].map(key => createV3Task(sql, runId, "historical_record", `budget-${key}`, "team_brief", "metric-normalizer")));
      const outcomes = await Promise.allSettled(tasks.map(task => assertModelBudgetAvailable({ researchRunId: runId,
        taskId: task.id, stageId: task.stage_id, modelTier: "cheap", reserveUsd: 0.1 })));
      assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter(r => r.status === "rejected").length, 1);
      const winner = tasks[outcomes.findIndex(r => r.status === "fulfilled")];
      await recordModelCall({ researchRunId: runId, taskId: winner.id, stageId: winner.stage_id,
        modelProvider: "mock", modelName: "test", modelTier: "cheap", costUsd: 0.2, status: "success" });
      const [run] = await sql`SELECT actual_cost_usd FROM research_runs WHERE id = ${runId}`;
      assert.equal(Number(run.actual_cost_usd), 0.2, "actual cost must never disappear because it exceeded the estimate");
      const [task] = await sql`SELECT input_json, budget_reservation_usd FROM research_tasks WHERE id = ${winner.id}`;
      assert.equal(task.budget_reservation_usd, null);
      assert.equal(task.input_json.budget_reservation, undefined, "the reservation never touches input_json");
      await assert.rejects(assertModelBudgetAvailable({ researchRunId: runId, taskId: winner.id, stageId: winner.stage_id,
        modelTier: "cheap", reserveUsd: 0.1 }), /budget exceeded/);
    } finally { await deleteAssetCascade(sql, testAssetId, runId); }
  });

  test("model task reuse follows inputs and contracts, and rejects invalid cached output", async () => {
    const response = await createRun(request({ run_type: "deep_dive", budget_limit_usd: 100 }), paramsFor(testAssetId));
    assert.equal(response.status, 201);
    const { id: runId } = await response.json();
    const ctx = await loadRunContext(sql, runId);
    const params = {
      sql, ctx, stageKey: "historical_record", taskKey: "cache-regression",
      taskType: "metric_normalization", agentName: "metric-normalizer" as const, modelTier: "cheap",
      packet: { revision: 1 }, prompt: "Normalize this fixture.",
      outputFormat: { requiredKeys: ["normalized_observations"], schema: {
        type: "object", required: ["normalized_observations"],
        properties: { normalized_observations: { type: "array" } },
      } },
    };
    const calls = async () => Number((await sql`SELECT count(*) AS count FROM model_call_logs WHERE research_run_id = ${runId}`)[0].count);
    await callResearchAgent(params);
    assert.equal(await calls(), 1);
    await callResearchAgent(params);
    assert.equal(await calls(), 1, "Identical successful request is reused");
    await callResearchAgent({ ...params, packet: { revision: 2 } });
    await callResearchAgent({ ...params, prompt: "Normalize the revised fixture." });
    await callResearchAgent({ ...params, outputFormat: { ...params.outputFormat, schema: { ...params.outputFormat.schema, description: "Revised contract" } } });
    assert.equal(await calls(), 4, "Input, prompt, and contract changes each require a new call");
    await sql`UPDATE research_tasks SET output_json = '{}'::jsonb WHERE research_run_id = ${runId}`;
    await callResearchAgent(params);
    assert.equal(await calls(), 5, "An invalid cached result is regenerated");
    const rejected = await sql`SELECT id FROM research_tasks WHERE research_run_id = ${runId} AND validation_status = 'invalid'`;
    assert.equal(rejected.length, 1);
    await sql`UPDATE research_runs SET status = 'running' WHERE id = ${runId}`;
    await sql`UPDATE research_stages SET status = 'running' WHERE research_run_id = ${runId} AND stage_key = 'historical_record'`;
    const retry = await advanceStage(runId, { valid: false, errors: ["Invalid fixture stage"], warnings: [], checkedAt: new Date().toISOString() });
    assert.equal(retry.action, "retry");
    await callResearchAgent(params);
    assert.equal(await calls(), 6, "Stage retry must not replay output rejected by stage validation");
    await assert.rejects(createArtifactRepository(db).upsertArtifact({
      research_run_id: runId, asset_id: testAssetId, artifact_type: "company_genesis",
      scope_key: "invalid-fixture", status: "validated", content_json: {},
      schema_version: "3.0.0", validator_version: "1.0.0", prompt_version: "test", created_by: "test",
    }), /Invalid company_genesis/);
    await deleteAssetCascade(sql, testAssetId, runId);
  });

  test("C9-T3: Failure cleanup on forced required stage failure", async () => {
    const runId = crypto.randomUUID();
    const cutoffAt = "2026-01-01T00:00:00.000Z";

    await sql`
      INSERT INTO research_runs (
        id, asset_id, run_type, status, research_question, requested_by,
        profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
        budget_limit_usd, pipeline_version, metadata_json
      ) VALUES (
        ${runId}, ${testAssetId}, 'deep_dive', 'pending', 'Failure cleanup test?', 'system-test-harness',
        ${financialsProfileId}, 1, ${cutoffAt}, ${cutoffAt},
        100.00, 3, ${sql.json({ acceptance_provider: "mock" })}
      )
    `;
    await sql`
      INSERT INTO asset_profile_assignments (
        asset_id, research_run_id, profile_id, assignment_reason,
        assigned_by, confidence, status
      ) VALUES (
        ${testAssetId}, ${runId}, ${financialsProfileId},
        'Run-scoped assignment', 'system-test-harness', '1.0', 'active'
      )
    `;

    await createStagesForRun(runId);

    // Fail one required stage directly
    await sql`
      UPDATE research_stages
      SET status = 'failed', failure_reason = 'Simulated stage failure'
      WHERE research_run_id = ${runId} AND stage_key = 'source_discovery'
    `;

    const state = await runResearchPipeline(runId);
    assert.ok(["failed", "needs_more_work"].includes(state.status));

    // Zero running stages and tasks remain
    const runningStages = await sql`SELECT id FROM research_stages WHERE research_run_id = ${runId} AND status = 'running'`;
    assert.equal(runningStages.length, 0);

    const runningTasks = await sql`SELECT id FROM research_tasks WHERE research_run_id = ${runId} AND status = 'running'`;
    assert.equal(runningTasks.length, 0);

    // No export artifact created
    const exports = await sql`SELECT id FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = 'synthetic_report'`;
    assert.equal(exports.length, 0);

    // The same public enqueue path resets failed stages and resumes at the first gate.
    const resumed = await queueRun(request(), paramsFor(runId));
    assert.equal(resumed.status, 202);
    const resumedState = await runQueuedJob(runId);
    assert.equal(resumedState.status, "waiting_for_human");
    const failedStages = await sql`SELECT id FROM research_stages WHERE research_run_id = ${runId} AND status = 'failed'`;
    assert.equal(failedStages.length, 0);
    await deleteAssetCascade(sql, testAssetId, runId);
  });
});
