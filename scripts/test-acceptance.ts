// ============================================================
// End-to-end acceptance test — SOFI full_initiation_report
// through the current pipeline with mock provider.
// ============================================================

import postgres from "postgres";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createStagesForRun, approveResearchPlan, approveHumanReview } from "../src/lib/workflow/orchestrator";
import { runSystemResearchPipeline } from "../src/lib/research/system-pipeline";
import { getAllStagesForRun } from "../src/lib/workflow/stages";
import {
  COMPANY_GENESIS_CONTRACT, HISTORICAL_DIAGNOSIS_CONTRACT, BUSINESS_PROCESS_CONTRACT,
  MOAT_CONTRACT, OPERATING_MODEL_CONTRACT, OPERATING_SCENARIOS_CONTRACT,
  VALUATION_CONTRACT, DECISION_SYNTHESIS_CONTRACT
} from "../src/lib/research/stage-contracts";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    const rawValue = valueParts.join("=").trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

// ---------------------------------------------------------------------------
// Force settings for deterministic acceptance
// ---------------------------------------------------------------------------
loadEnvFile(".env.local");
loadEnvFile(".env");

process.env.RESEARCH_MODEL_PROVIDER = "mock";
process.env.RESEARCH_ACCEPTANCE_PROVIDER = "mock";
process.env.RESEARCH_TEST_MODE = "1";

const SOFI_QUESTION = [
  "Explain why SoFi was founded and how its strategic identity evolved from student-loan refinancing",
  "into a diversified financial-services and technology-platform company.",
  "Evaluate member growth, cross-buying, deposits and funding costs, lending volumes and credit quality,",
  "Financial Services monetization, Galileo/Technisys economics, capital requirements, competitive position,",
  "and valuation under bear, base, and bull scenarios.",
].join(" ");

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
let failures = 0;
function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); failures++; }

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------
async function main() {
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID();
  console.log(`\n🔬 SOFI E2E acceptance test — run ${runId}\n`);

  try {
    // ---- 1. Find SOFI asset ----
    const assetRows = await sql`
      SELECT a.id, a.canonical_name, a.slug, a.primary_profile_id, rp.version AS profile_version, l.symbol
      FROM assets a
      JOIN research_profiles rp ON rp.id = a.primary_profile_id
      LEFT JOIN instruments i ON i.asset_id = a.id
      LEFT JOIN listings l ON l.instrument_id = i.id AND l.is_primary = true
      WHERE LOWER(a.slug) = 'sofi' OR UPPER(l.symbol) = 'SOFI'
      ORDER BY l.is_primary DESC NULLS LAST LIMIT 1
    `;
    const asset = assetRows[0];
    if (!asset) throw new Error("SOFI asset not found — seed database first (npx tsx src/db/seed.ts)");

    // ---- 2. Create run ----
    const cutoffAt = "2024-10-30T00:00:00Z";
    await sql`
      INSERT INTO research_runs (
        id, asset_id, run_type, status, research_question, requested_by,
        profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
        budget_limit_usd, pipeline_version, metadata_json
      ) VALUES (
        ${runId}, ${asset.id}, 'full_initiation_report', 'pending', ${SOFI_QUESTION}, 'test-harness',
        ${asset.primary_profile_id}, ${Number(asset.profile_version || 1)}, ${cutoffAt}, ${cutoffAt},
        '10.00', 3,
        ${sql.json({ acceptance_provider: 'mock', cutoff_at_utc: cutoffAt, acceptance_asset: 'SOFI' })}
      )
    `;
    await sql`
      INSERT INTO asset_profile_assignments (
        asset_id, research_run_id, profile_id, assignment_reason, assigned_by, confidence, status
      ) VALUES (${asset.id}, ${runId}, ${asset.primary_profile_id}, 'test', 'test-harness', '1.0', 'active')
    `;

    // ---- 3. Create stages & run ----
    await createStagesForRun(runId);
    let result = await runSystemResearchPipeline(runId);

    // Approve research_plan if needed
    const [planStage] = await sql`
      SELECT status FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
    `;
    if (result.status === "waiting_for_human" && planStage?.status === "waiting_for_human") {
      console.log("  → Approving research plan gate...");
      await approveResearchPlan(runId, "test-harness");
      result = await runSystemResearchPipeline(runId);
    }

    // Approve human_review if needed
    const [hrStage] = await sql`
      SELECT status FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = 'human_review'
    `;
    if (result.status === "waiting_for_human" && hrStage?.status === "waiting_for_human") {
      console.log("  → Inserting review decision and approving human review gate...");
      // Insert a review_decision (required by approveHumanReview)
      await sql`
        INSERT INTO review_decisions (research_run_id, asset_id, status, reviewed_by, reviewed_at)
        VALUES (${runId}, (SELECT asset_id FROM research_runs WHERE id = ${runId}), 'approved_for_tracking', 'test-harness', NOW())
      `;
      await approveHumanReview(runId, "test-harness");
      result = await runSystemResearchPipeline(runId);
    }

    // ---- 4. Verify pipeline status ----
    console.log("\n📋 Stage verification:");
    const stages = await sql`
      SELECT stage_key, status, failure_reason, completed_at
      FROM research_stages
      WHERE research_run_id = ${runId}
      ORDER BY COALESCE(completed_at, '9999-12-31'::timestamptz), stage_key
    `;

    const allStageKeys = getAllStagesForRun("full_initiation_report");
    const applicableKeys = allStageKeys.applicable.map(s => s.key);
    const skippedKeys = new Set(allStageKeys.skipped.map(s => s.key));
    const completedStages = new Set((stages as any[]).filter((s: any) => s.status === "completed").map((s: any) => s.stage_key));
    const failedStages = (stages as any[]).filter((s: any) => s.status === "failed");

    for (const s of stages as any[]) {
      const status = s.status;
      const mark = status === "completed" ? "✓" : status === "skipped" ? "—" : status === "failed" ? "✗" : "?";
      console.log(`  ${mark} ${s.stage_key.padEnd(28)} ${status.padEnd(12)} ${s.failure_reason ? `(${s.failure_reason})` : ""}`);
    }

    // Check all required stages
    for (const key of applicableKeys) {
      if (skippedKeys.has(key)) continue; // Stage filtered by run_type
      if (!completedStages.has(key)) fail(`Stage ${key} should be completed`);
      else pass(`Stage ${key} completed`);
    }

    // Check export ran last (export should be the last completed stage)
    const completedKeys = (stages as any[]).filter((s: any) => s.status === "completed").map((s: any) => s.stage_key);
    if (completedKeys.length > 0) {
      const lastStage = completedKeys[completedKeys.length - 1];
      if (lastStage === "refresh_schedule") pass("refresh_schedule runs last");
      else if (lastStage === "export") pass("export runs before refresh_schedule");
      else fail(`Unexpected final stage: ${lastStage} (expected export or refresh_schedule)`);
    }

    // ---- 5. Verify artifacts ----
    console.log("\n📦 Artifact verification:");
    const artifacts = await sql`
      SELECT artifact_type, status, scope_key, created_at
      FROM research_artifacts
      WHERE research_run_id = ${runId}
      ORDER BY created_at
    `;

    const expectedArtifacts = [
      ...COMPANY_GENESIS_CONTRACT.requiredKeys,
      ...HISTORICAL_DIAGNOSIS_CONTRACT.requiredKeys,
      ...BUSINESS_PROCESS_CONTRACT.requiredKeys,
      ...MOAT_CONTRACT.requiredKeys,
      ...OPERATING_MODEL_CONTRACT.requiredKeys,
      ...OPERATING_SCENARIOS_CONTRACT.requiredKeys,
      ...VALUATION_CONTRACT.requiredKeys,
      ...DECISION_SYNTHESIS_CONTRACT.requiredKeys,
      "synthetic_report", "refresh_schedule"
    ];

    const artifactTypes = new Set((artifacts as any[]).map((a: any) => a.artifact_type));
    for (const at of expectedArtifacts) {
      if (artifactTypes.has(at)) pass(`Artifact ${at} persisted`);
      else fail(`Artifact ${at} missing`);
    }

    // Verify all artifacts are "validated" or "accepted"
    for (const a of artifacts as any[]) {
      if (a.status !== "validated" && a.status !== "accepted") {
        fail(`Artifact ${a.artifact_type} has unexpected status: ${a.status}`);
      }
    }

    // Verify synthetic_report has export metadata
    const [synthetic] = await sql`
      SELECT content_json FROM research_artifacts
      WHERE research_run_id = ${runId} AND artifact_type = 'synthetic_report'
    `;
    if (synthetic && (synthetic.content_json as any)?.exportId) {
      pass("Synthetic report has exportId");
    } else {
      fail("Synthetic report missing exportId");
    }

    // ---- 6. Final run status ----
    const [run] = await sql`
      SELECT status, actual_cost_usd, failure_reason
      FROM research_runs
      WHERE id = ${runId}
    `;

    console.log(`\n🏁 Final run status: ${run?.status}`);
    if (run?.status === "completed") pass("Run completed successfully");
    else if (run?.status === "failed") fail(`Run failed: ${run?.failure_reason}`);
    else fail(`Run ended with unexpected status: ${run?.status}`);

  } finally {
    await sql.end();
  }

  // ---- Report ----
  console.log(`\n${"=".repeat(50)}`);
  if (failures === 0) {
    console.log("✅ ALL checks passed — SOFI E2E acceptance test PASSED");
  } else {
    console.log(`❌ ${failures} check(s) FAILED`);
  }
  console.log("=".repeat(50) + "\n");

  // Sanitize test data (optional — keep for debugging)
  // await cleanup(sql, runId);

  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("Fatal test error:", error);
  process.exitCode = 1;
});
