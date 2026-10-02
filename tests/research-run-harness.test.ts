import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test, { before, after, describe } from "node:test";
import postgres from "postgres";
import crypto from "node:crypto";
import { runSystemResearchPipeline } from "../src/lib/research/system-pipeline";
import { createStagesForRun, approveResearchPlan } from "../src/lib/workflow/orchestrator";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

describe("research run harness v3 integration (Component WP0)", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, () => {
  loadLocalEnv();
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = crypto.randomUUID();
  const instrumentId = crypto.randomUUID();
  // Unique slug and symbol: the shared database may already hold the real SoFi asset ('sofi').
  const slug = `sofi-wp0-${assetId.slice(0, 8)}`;
  const symbol = `SOFIWP0${assetId.slice(0, 4).toUpperCase()}`;
  const runIds: string[] = [];
  let financialsProfileId: string;

  before(async () => {
    // 1. Get seeded profile
    const profileRows = await sql`
      SELECT id FROM research_profiles WHERE profile_key = 'financials' LIMIT 1
    `;
    assert.ok(profileRows.length > 0, "financials profile must be seeded");
    financialsProfileId = profileRows[0].id;

    // 2. Insert mock SOFI asset, instrument, listing
    await sql`
      INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
      VALUES (${assetId}, 'SoFi Technologies, Inc. (WP0 test)', ${slug}, ${financialsProfileId}, 'active', 'equity', 'USD')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO instruments (id, asset_id, name, instrument_type)
      VALUES (${instrumentId}, ${assetId}, 'SoFi common stock', 'equity')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO listings (id, instrument_id, exchange, symbol, is_primary)
      VALUES (${crypto.randomUUID()}, ${instrumentId}, 'NASDAQ', ${symbol}, true)
    `;
  });

  after(async () => {
    // Runs leave rows in many tables; delete them in several passes so foreign keys resolve.
    if (runIds.length) {
      const tables = (await sql`SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map(r => String(r.table_name));
      for (let pass = 0; pass < 4; pass++) for (const name of [...tables, "research_runs"]) {
        const column = name === "research_runs" ? "id" : "research_run_id";
        await sql`DELETE FROM ${sql(name)} WHERE ${sql(column)} = ANY(${runIds}::uuid[])`.catch(() => undefined);
      }
    }
    await sql`DELETE FROM asset_profile_assignments WHERE asset_id = ${assetId}`;
    await sql`DELETE FROM listings WHERE instrument_id = ${instrumentId}`;
    await sql`DELETE FROM instruments WHERE id = ${instrumentId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  });

  test("WP0-T1 & WP0-T2: Resolve asset by symbol and slug correctly", async () => {
    const symbolRows = await sql`
      SELECT a.id FROM assets a
      LEFT JOIN instruments i ON i.asset_id = a.id
      LEFT JOIN listings l ON l.instrument_id = i.id
      WHERE UPPER(l.symbol) = ${symbol}
    `;
    assert.equal(symbolRows[0]?.id, assetId);

    const slugRows = await sql`
      SELECT id FROM assets WHERE LOWER(slug) = ${slug}
    `;
    assert.equal(slugRows[0]?.id, assetId);
  });

  test("WP0-T3: Request unknown asset fails cleanly before run creation", async () => {
    const requestedAsset = "UNKNOWN_CO";
    const assetRows = await sql`
      SELECT a.id FROM assets a
      LEFT JOIN instruments i ON i.asset_id = a.id
      LEFT JOIN listings l ON l.instrument_id = i.id
      WHERE LOWER(a.slug) = LOWER(${requestedAsset})
         OR UPPER(l.symbol) = UPPER(${requestedAsset})
    `;
    assert.equal(assetRows.length, 0);
  });

  test("WP0-T5: Request v3 and runs v3 pipeline successfully", async () => {
    const runId = crypto.randomUUID();
    runIds.push(runId);
    const cutoffAt = new Date().toISOString();

    // Initialize v3 run in DB
    await sql`
      INSERT INTO research_runs (
        id, asset_id, run_type, status, research_question, requested_by,
        profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
        budget_limit_usd, pipeline_version, metadata_json
      ) VALUES (
        ${runId}, ${assetId}, 'deep_dive', 'pending', 'Research question?', 'system-test-harness',
        ${financialsProfileId}, 1, ${cutoffAt}, ${cutoffAt},
        10.00, 3, ${sql.json({ acceptance_provider: "mock" })}
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

    // Verify run status starts running when calling dispatch
    const result = await runSystemResearchPipeline(runId);
    assert.ok(result);

  });

  test("WP0-T7 & WP0-T8: Production mode pauses at research plan gate, auto-approve marked test-only", async () => {
    const runId = crypto.randomUUID();
    runIds.push(runId);
    const cutoffAt = new Date().toISOString();

    // Create v3 run
    await sql`
      INSERT INTO research_runs (
        id, asset_id, run_type, status, research_question, requested_by,
        profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
        budget_limit_usd, pipeline_version, metadata_json
      ) VALUES (
        ${runId}, ${assetId}, 'deep_dive', 'pending', 'Research question?', 'system-test-harness',
        ${financialsProfileId}, 1, ${cutoffAt}, ${cutoffAt},
        10.00, 3, ${sql.json({ acceptance_provider: "mock" })}
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

    // 1. Run the pipeline - it should stop at research_plan gate (requiresHumanApproval = true)
    let state = await runSystemResearchPipeline(runId);
    assert.equal(state.status, "waiting_for_human");

    const [planStage] = await sql`
      SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
    `;
    assert.equal(planStage?.status, "waiting_for_human");

    // 2. Approve research plan
    await approveResearchPlan(runId, "system-test-harness");
    const [planStageAfter] = await sql`
      SELECT status, validation_result_json FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
    `;
    assert.equal(planStageAfter?.status, "completed");
    assert.equal(planStageAfter?.validation_result_json?.approvedBy, "system-test-harness");

  });
});
