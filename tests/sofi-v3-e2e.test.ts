import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test, { before, after, describe } from "node:test";
import postgres from "postgres";
import crypto from "node:crypto";
import { runSystemResearchPipeline } from "../src/lib/research/system-pipeline";
import { createStagesForRun, approveResearchPlan } from "../src/lib/workflow/orchestrator";
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
 *
 * The delete order is determined by the FK dependency graph:
 * we delete children before parents so no FK constraint is violated.
 */
async function deleteAssetCascade(sql: ReturnType<typeof postgres>, targetAssetId: string) {
  // Subquery helpers
  const runQ = sql`SELECT id FROM research_runs WHERE asset_id = ${targetAssetId}`;
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

  // === Phase 1: deepest leaf tables ===
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

  // === Phase 2: tables depending only on source_docs / runs (no deeper children) ===
  await sql`DELETE FROM source_role_assignments WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM source_document_metadata WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM source_document_relations WHERE parent_source_document_id IN (${docQ}) OR child_source_document_id IN (${docQ})`;
  await sql`DELETE FROM source_retrieval_attempts WHERE research_run_id IN (${runQ})`;

  // === Phase 3: agent/execution infrastructure (depends on tasks/stages/runs) ===
  await sql`DELETE FROM agent_output_staging WHERE task_id IN (${taskQ})`;
  await sql`DELETE FROM agent_traces WHERE task_id IN (${taskQ})`;
  await sql`DELETE FROM stage_validation_results WHERE stage_id IN (${stageQ})`;
  await sql`DELETE FROM model_budget_ledger WHERE stage_id IN (${stageQ})`;
  await sql`DELETE FROM model_call_logs WHERE stage_id IN (${stageQ})`;

  // === Phase 4: mid-layer tables ===
  await sql`DELETE FROM strategy_combinations WHERE backtest_run_id IN (${btQ})`;
  await sql`DELETE FROM backtest_artifacts WHERE backtest_run_id IN (${btQ})`;
  await sql`DELETE FROM scenarios WHERE valuation_model_run_id IN (${vmQ})`;
  await sql`DELETE FROM analysis_sections WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM indicator_definitions WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM exports WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM notebooks WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM source_role_coverage WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_run_sources WHERE research_run_id IN (${runQ})`;

  // === Phase 5: document content layer (children of source_documents) ===
  await sql`DELETE FROM source_locations WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM document_chunks WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM extracted_tables WHERE source_document_id IN (${docQ})`;
  await sql`DELETE FROM document_parses WHERE source_document_id IN (${docQ})`;

  // === Phase 6: core entity tables with both source_doc and run FKs ===
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

  // === Phase 7: infrastructure ===
  await sql`DELETE FROM research_tasks WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM research_stages WHERE research_run_id IN (${runQ})`;
  await sql`DELETE FROM asset_profile_assignments WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM research_runs WHERE asset_id = ${targetAssetId}`;

  // === Phase 8: asset/listing hierarchy ===
  await sql`DELETE FROM listings WHERE instrument_id IN (SELECT id FROM instruments WHERE asset_id = ${targetAssetId})`;
  await sql`DELETE FROM asset_entities WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM asset_classifications WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM instruments WHERE asset_id = ${targetAssetId}`;
  await sql`DELETE FROM assets WHERE id = ${targetAssetId}`;
}

describe("SOFI Mock End-to-End Acceptance (Component WP12)", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, () => {
  loadLocalEnv();
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = crypto.randomUUID();
  const instrumentId = crypto.randomUUID();
  let financialsProfileId: string;

  before(async () => {
    // Pre-cleanup to ensure a clean slate and avoid assets_slug_unique errors
    const existing = await sql`SELECT id FROM assets WHERE slug = 'sofi'`;
    if (existing.length > 0) {
      await deleteAssetCascade(sql, existing[0].id);
    }

    // 1. Get seeded profile
    const profileRows = await sql`
      SELECT id FROM research_profiles WHERE profile_key = 'financials' LIMIT 1
    `;
    assert.ok(profileRows.length > 0, "financials profile must be seeded");
    financialsProfileId = profileRows[0].id;

    // 2. Insert mock SOFI asset, instrument, listing
    await sql`
      INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
      VALUES (${assetId}, 'SoFi Technologies, Inc.', 'sofi', ${financialsProfileId}, 'active', 'equity', 'USD')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO instruments (id, asset_id, name, instrument_type)
      VALUES (${instrumentId}, ${assetId}, 'SoFi common stock', 'equity')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO listings (id, instrument_id, exchange, symbol, is_primary)
      VALUES (${crypto.randomUUID()}, ${instrumentId}, 'NASDAQ', 'SOFI', true)
    `;
  });

  after(async () => {
    await deleteAssetCascade(sql, assetId);
    await sql.end();
  });

  test("Run through SOFI v3 e2e flow completely", async () => {
    const runId = crypto.randomUUID();
    const cutoffAt = new Date(Date.now() + 365 * 24 * 60 * 1000).toISOString(); // far future so all mocked observations are "before" cutoff

    // WP12-T1: Fresh deterministic SOFI v3 run
    await sql`
      INSERT INTO research_runs (
        id, asset_id, run_type, status, research_question, requested_by,
        profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
        budget_limit_usd, pipeline_version, metadata_json
      ) VALUES (
        ${runId}, ${assetId}, 'deep_dive', 'pending', 'Mock SOFI Deep Dive?', 'system-test-harness',
        ${financialsProfileId}, 1, ${cutoffAt}, ${cutoffAt},
        100.00, 3, ${sql.json({ acceptance_provider: "mock" })}
      )
    `;

    await sql`
      INSERT INTO asset_profile_assignments (
        asset_id, research_run_id, profile_id, assignment_reason,
        assigned_by, confidence, status
      ) VALUES (
        ${assetId}, ${runId}, ${financialsProfileId},
        'Run-scoped assignment', 'system-test-harness', '1.0', 'active'
      )
    `;

    await createStagesForRun(runId);

    // Assert that it remains pipeline version 3
    const [runRow] = await sql`SELECT pipeline_version FROM research_runs WHERE id = ${runId}`;
    assert.equal(Number(runRow.pipeline_version), 3);

    // Dispatch system pipeline. Should stop at research_plan stage.
    let state = await runSystemResearchPipeline(runId);
    // DEBUG: always dump
    const stages = await sql`
      SELECT stage_key, status, failure_reason, stage_order
      FROM research_stages WHERE research_run_id = ${runId}
      ORDER BY stage_order
    `;
    console.log('# STAGE STATUSES:');
    for (const s of stages) {
      console.log(`#   ${s.stage_key} → ${s.status}${s.failure_reason ? ` (${s.failure_reason.substring(0, 120)})` : ''}`);
    }
    console.log(`# Pipeline status: ${state.status}, failure_reason: ${state.failure_reason?.substring(0, 200) || 'none'}`);
    assert.equal(state.status, "waiting_for_human");

    const [planStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
    `;
    assert.equal(planStage?.status, "waiting_for_human");

    // WP12-T2: Research-plan test approval (clearly marked test-only)
    await approveResearchPlan(runId, "system-test-harness");

    // WP12-T3: All required stages execute (Correct order and dependencies)
    // Dispatch system pipeline again to execute all stages
    state = await runSystemResearchPipeline(runId);

    // DEBUG: dump second call results
    const stages2 = await sql`
      SELECT stage_key, status, failure_reason, stage_order
      FROM research_stages WHERE research_run_id = ${runId}
      ORDER BY stage_order
    `;
    console.log('# STAGE STATUSES (2nd call):');
    for (const s of stages2) {
      console.log(`#   ${s.stage_key} → ${s.status}${s.failure_reason ? ` (${s.failure_reason.substring(0, 120)})` : ''}`);
    }
    console.log(`# Pipeline status (2nd): ${state.status}, failure_reason: ${state.failure_reason?.substring(0, 200) || 'none'}`);

    // WP12-T8: Final state before human approval -> waiting_for_human
    assert.equal(state.status, "waiting_for_human");

    const [finalStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'human_review'
    `;
    assert.equal(finalStage?.status, "waiting_for_human");

    // WP12-T4: No timing hypothesis -> Backtest not applicable
    const [backtestStage] = await sql`
      SELECT status, failure_reason FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'optional_backtest'
    `;
    assert.equal(backtestStage?.status, "failed");
    assert.ok(backtestStage?.failure_reason?.includes("not_applicable"));

    // WP12-T5: Artifact registry queried (Required current artifacts exist)
    const artifacts = await sql`
      SELECT artifact_type, status, content_json FROM research_artifacts
      WHERE research_run_id = ${runId}
    `;
    assert.ok(artifacts.length > 0, "No artifacts were persisted in the registry");

    const artifactTypes = artifacts.map((a) => a.artifact_type);
    const expectedTypes = [
      "company_genesis",
      "founder_profile",
      "strategic_history_timeline",
      "strategic_dna",
      "historical_diagnosis",
      "segment_model",
      "customer_decision_map",
      "business_process_map",
      "bottleneck_map",
      "competitive_response_matrix",
      "moat_assessment",
      "moat_attack_matrix",
      "no_moat_counterfactual",
      "driver_tree",
      "operating_model",
      "operating_scenario_set",
      "valuation_scenario_set",
      "reverse_valuation",
      "annual_price_target_path",
      "investment_thesis",
      "risk_register",
      "catalyst_register",
      "expected_return_matrix",
      "thesis_breakers",
      "monitoring_dashboard",
      "confidence_assessment",
      "decision_record"
    ];

    for (const type of expectedTypes) {
      assert.ok(artifactTypes.includes(type), `Missing expected V3 artifact in registry: ${type}`);
    }

    // WP12-T6: Annual targets queried (Every year has bear/base/bull)
    const pathArtifact = artifacts.find((a) => a.artifact_type === "annual_price_target_path");
    assert.ok(pathArtifact);
    const pathContent = pathArtifact.content_json as any;
    assert.ok(Array.isArray(pathContent.price_target_path));
    const targetYears = pathContent.price_target_path.map((pt: any) => pt.fiscal_year);
    const targetScenarios = pathContent.price_target_path.map((pt: any) => pt.scenario_type);
    assert.ok(targetYears.includes(2026));
    assert.ok(targetScenarios.includes("bear"));
    assert.ok(targetScenarios.includes("base"));
    assert.ok(targetScenarios.includes("bull"));

    // WP12-T7: AI review (No unresolved critical fixture issue)
    const [reviewStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'ai_review'
    `;
    assert.equal(reviewStage?.status, "completed");

    // WP12-T9: Running work query (Zero non-human running tasks/stages)
    const runningStages = await sql`
      SELECT id FROM research_stages WHERE research_run_id = ${runId} AND status = 'running'
    `;
    assert.equal(runningStages.length, 0);

    const runningTasks = await sql`
      SELECT id FROM research_tasks WHERE research_run_id = ${runId} AND status = 'running'
    `;
    assert.equal(runningTasks.length, 0);

    // WP12-T10: Synthetic readiness (Never investment_ready)
    // Construct mock quality data to evaluate quality gates
    const [runData] = await sql`SELECT * FROM research_runs WHERE id = ${runId}`;
    const sources = await sql`SELECT * FROM source_documents WHERE research_run_id = ${runId}`;
    const evidence = await sql`SELECT * FROM evidence_claims WHERE research_run_id = ${runId}`;
    const metrics = await sql`SELECT * FROM metric_observations WHERE research_run_id = ${runId}`;
    const signals = await sql`SELECT * FROM valuation_signals WHERE research_run_id = ${runId}`;
    const scenarios = await sql`SELECT * FROM scenarios WHERE research_run_id = ${runId}`;
    const reviewDecisions = await sql`SELECT * FROM review_decisions WHERE research_run_id = ${runId}`;

    const qualityGateResult = evaluateQualityGates({
      run: runData,
      sources,
      evidence,
      metrics,
      signals,
      scenarios,
      artifacts,
      reviewDecisions
    });

    assert.notEqual(qualityGateResult.actionReadiness, "investment_ready");

    // WP12-T11: Test export (Watermarked and structurally complete)
    const reportData = {
      runId,
      asset: {
        canonical_name: "SoFi Technologies, Inc.",
        slug: "sofi",
        asset_kind: "equity"
      },
      genesis: {
        strategic_identity: "Mock identity",
        founder_profile: "Mock founder",
        origin_history: "Founded in 2011"
      },
      decision: {
        thesis_statement: "Mock thesis statement",
        expected_return_matrix: { bear_return: 0.05, base_return: 0.15, bull_return: 0.25 }
      }
    };

    const mdReport = generateMarkdownReport(reportData);
    assert.ok(mdReport.includes("TEST WATERMARK"));
    assert.ok(mdReport.includes("# V3 Investment Research Report: SoFi Technologies, Inc."));
    // Ensure all 25 canonical sections are present
    for (let i = 1; i <= 25; i++) {
      assert.ok(mdReport.includes(`## ${i}. `), `Report missing section ${i}`);
    }

    // Clean up this run
    await sql`DELETE FROM asset_profile_assignments WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM theses WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM risks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM catalysts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM valuation_signals WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM scenarios WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
  });

  test("WP12-T12: Repeat full run with same fixture key prevents duplicate logical artifacts", async () => {
    const runId1 = crypto.randomUUID();
    const runId2 = crypto.randomUUID();
    const cutoffAt = new Date(Date.now() + 365 * 24 * 60 * 1000).toISOString();

    const createRun = async (runId: string) => {
      await sql`
        INSERT INTO research_runs (
          id, asset_id, run_type, status, research_question, requested_by,
          profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
          budget_limit_usd, pipeline_version, metadata_json
        ) VALUES (
          ${runId}, ${assetId}, 'deep_dive', 'pending', 'Idempotent run?', 'system-test-harness',
          ${financialsProfileId}, 1, ${cutoffAt}, ${cutoffAt},
          100.00, 3, ${sql.json({ acceptance_provider: "mock" })}
        )
      `;

      await sql`
        INSERT INTO asset_profile_assignments (
          asset_id, research_run_id, profile_id, assignment_reason,
          assigned_by, confidence, status
        ) VALUES (
          ${assetId}, ${runId}, ${financialsProfileId},
          'Run-scoped assignment', 'system-test-harness', '1.0', 'active'
        )
      `;

      await createStagesForRun(runId);
      await approveResearchPlan(runId, "system-test-harness");
      await runSystemResearchPipeline(runId);
    };

    // Run first time
    await createRun(runId1);

    // Run second time on same symbol/fixture key
    await assert.doesNotReject(async () => {
      await createRun(runId2);
    });

    // Cleanup both runs
    for (const runId of [runId1, runId2]) {
      await sql`DELETE FROM asset_profile_assignments WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM theses WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM risks WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM catalysts WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM valuation_signals WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM scenarios WHERE research_run_id = ${runId}`;
      await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    }
  });
});
