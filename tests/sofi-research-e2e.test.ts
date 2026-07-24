import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test, { before, after, describe } from "node:test";
import postgres from "postgres";
import crypto from "node:crypto";
import { runResearchPipeline } from "../src/lib/research/pipeline-runner";
import { runSystemResearchPipeline } from "../src/lib/research/system-pipeline";
import { createStagesForRun, approveResearchPlan, approveHumanReview } from "../src/lib/workflow/orchestrator";
import { evaluateQualityGates } from "../src/lib/workflow/quality-gates";
import { generateMarkdownReport } from "../src/lib/export/report-generator";

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
  const docQ = sql`SELECT id FROM source_documents WHERE asset_id = ${targetAssetId}`;
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
  await sql`DELETE FROM source_documents WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM source_gaps WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM review_decisions WHERE research_run_id IN (${runQ})`;

  // Phase 7: infrastructure
  await sql`DELETE FROM research_tasks WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_stages WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM asset_profile_assignments WHERE ${targetRunId ? sql`research_run_id IN (${runQ})` : sql`asset_id = ${targetAssetId}`}`;
  await sql`DELETE FROM research_runs WHERE ${targetRunId ? sql`id IN (${runQ})` : sql`asset_id = ${targetAssetId}`}`;

  // Phase 8: asset hierarchy
  if (targetRunId) return;
  await sql`DELETE FROM listings WHERE instrument_id IN (SELECT id FROM instruments WHERE asset_id = ${targetAssetId})`;
  await sql`DELETE FROM asset_entities WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM asset_classifications WHERE asset_id = ${targetAssetId}`;
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
  });

  test("C9-T1: Full research flow through all three pipeline invocations and gates", async () => {
    const runId = crypto.randomUUID();
    // Fixed historical cutoff date (Component 8/9 non-negotiable requirement)
    const cutoffAt = "2026-01-01T00:00:00.000Z";

    await sql`
      INSERT INTO research_runs (
        id, asset_id, run_type, status, research_question, requested_by,
        profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
        budget_limit_usd, pipeline_version, metadata_json
      ) VALUES (
        ${runId}, ${testAssetId}, 'deep_dive', 'pending', 'Mock SOFI Deep Dive?', 'system-test-harness',
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

    // ==========================================
    // Invocation 1: Reach research-plan gate
    // ==========================================
    let state = await runResearchPipeline(runId);
    assert.equal(state.status, "waiting_for_human");

    const [planStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
    `;
    assert.equal(planStage?.status, "waiting_for_human");

    // Zero non-human running work
    const runningTasks1 = await sql`SELECT id FROM research_tasks WHERE research_run_id = ${runId} AND status = 'running'`;
    assert.equal(runningTasks1.length, 0);

    // ==========================================
    // Gate 1 Approval: Approve Research Plan
    // ==========================================
    await approveResearchPlan(runId, "system-test-harness");

    // ==========================================
    // Invocation 2: Execute research through decision synthesis & AI review to human_review gate
    // ==========================================
    state = await runResearchPipeline(runId);
    assert.equal(state.status, "waiting_for_human");

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
      "no_moat_counterfactual", "driver_tree", "operating_model", "operating_scenario_set",
      "valuation_scenario_set", "reverse_valuation", "annual_price_target_path", "investment_thesis",
      "risk_register", "catalyst_register", "expected_return_matrix", "thesis_breakers",
      "monitoring_dashboard", "confidence_assessment", "decision_record"
    ];

    for (const type of expectedTypes) {
      assert.ok(artifactTypes.includes(type), `Missing expected artifact in registry: ${type}`);
    }

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
    const decisionId = crypto.randomUUID();
    await sql`
      INSERT INTO review_decisions (
        id, asset_id, research_run_id, status, reviewed_by, reviewed_at
      ) VALUES (
        ${decisionId}, ${testAssetId}, ${runId}, 'approved_for_tracking',
        'human-reviewer-1', NOW()
      )
    `;

    const approvalRes = await approveHumanReview(runId, "system-test-harness");
    assert.ok(approvalRes.success, `approveHumanReview failed: ${approvalRes.error}`);

    // ==========================================
    // Invocation 3: Execute terminal export and refresh_schedule stages
    // ==========================================
    state = await runResearchPipeline(runId);
    assert.equal(state.status, "completed");

    const [exportStage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'export'`;
    assert.equal(exportStage?.status, "completed");

    const [refreshStage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'refresh_schedule'`;
    assert.equal(refreshStage?.status, "completed");

    // Check synthetic report artifact created
    const [syntheticArtifact] = await sql`
      SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = 'synthetic_report'
    `;
    assert.ok(syntheticArtifact, "synthetic_report artifact must be created by export handler");

    const [refreshArtifact] = await sql`
      SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = 'refresh_schedule'
    `;
    assert.ok(refreshArtifact, "refresh_schedule artifact must be created by refresh handler");

    // Clean up run in FK-safe order without deleting the shared test asset.
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

    // Cleanup
    await sql`DELETE FROM asset_profile_assignments WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
  });
});
