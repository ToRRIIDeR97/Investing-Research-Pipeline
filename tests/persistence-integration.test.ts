import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { saveReportArtifact } from "../src/lib/research/reporting/store";
import { recordModelCall } from "../src/lib/agents/model-calls";
import { mergeGroupOutputs, persistMetrics } from "../src/lib/research/sources/corpus";
import { validatePointInTime } from "../src/lib/workflow/validators";
import { failRun } from "../src/lib/workflow/orchestrator";
import { enqueueTask } from "../src/lib/workflow/task-queue";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

test("metric claim lineage preserves reporting and publication dates without inventing availability", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID(), sourceId = crypto.randomUUID(), claimId = crypto.randomUUID();
  const metricKey = `lineage_fixture_${runId.replaceAll('-', '')}`;
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version, market_data_cutoff_at)
      VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 3, '2025-06-01T00:00:00Z')`;
    await sql`INSERT INTO source_documents (id, asset_id, source_type, title, published_at, retrieved_at, file_hash, storage_path)
      VALUES (${sourceId}, ${asset.id}, 'regulatory_filing', 'Lineage fixture', '2025-05-06T00:00:00Z', '2025-07-01T00:00:00Z', ${sourceId}, 'fixture')`;
    await sql`INSERT INTO research_run_sources (research_run_id, source_document_id) VALUES (${runId}, ${sourceId})`;
    await sql`INSERT INTO evidence_claims (id, asset_id, research_run_id, claim_text, claim_type, claim_category, as_of_date, generated_by, review_status)
      VALUES (${claimId}, ${asset.id}, ${runId}, 'Quarterly metric fixture', 'financial', 'fact', '2025-03-31', 'fixture', 'accepted')`;
    const [location] = await sql`INSERT INTO source_locations (source_document_id) VALUES (${sourceId}) RETURNING id`;
    await sql`INSERT INTO evidence_links (evidence_claim_id, source_location_id) VALUES (${claimId}, ${location.id})`;
    const ctx = { runId, assetId: asset.id, profileKey: 'financials', marketDataCutoffAt: '2025-06-01T00:00:00Z' } as any;
    const output = { normalized_observations: [{ metric_key: metricKey, value: 0, unit: 'USD', source_claim_id: claimId, period: '2025Q1' }] };
    await persistMetrics(sql, ctx, sourceId, output);
    await persistMetrics(sql, ctx, sourceId, output);
    const rows = await sql`SELECT * FROM metric_observations WHERE research_run_id = ${runId}`;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].value_numeric), 0);
    assert.equal(rows[0].evidence_claim_id, claimId);
    assert.equal(rows[0].source_document_id, sourceId);
    assert.equal(new Date(rows[0].period_end).toISOString().slice(0, 10), '2025-03-31');
    assert.equal(new Date(rows[0].available_at).toISOString().slice(0, 10), '2025-05-06');
    assert.equal((await validatePointInTime(runId)).valid, true);
    await persistMetrics(sql, ctx, sourceId, { normalized_observations: [{ ...output.normalized_observations[0], value: null, period_end: '2024-12-31' }] });
    const [missing] = await sql`SELECT value_numeric FROM metric_observations WHERE research_run_id = ${runId} AND period_end = '2024-12-31'`;
    assert.equal(missing.value_numeric, null, 'missing numeric data is SQL NULL, not zero or the string null');
    await sql`UPDATE source_documents SET published_at = NULL WHERE id = ${sourceId}`;
    await persistMetrics(sql, ctx, sourceId, { normalized_observations: [{ ...output.normalized_observations[0], value: 99 }] });
    const [unchanged] = await sql`SELECT value_numeric FROM metric_observations WHERE id = ${rows[0].id}`;
    assert.equal(Number(unchanged.value_numeric), 0, 'unknown publication after cutoff must not supersede verified data');
    const gaps = await sql`SELECT * FROM source_gaps WHERE research_run_id = ${runId}`;
    assert.equal(gaps.length, 1);
    await sql`UPDATE metric_observations SET available_at = '2025-07-01' WHERE research_run_id = ${runId}`;
    assert.equal((await validatePointInTime(runId)).valid, false, 'accepted future data remains blocked');
    await sql`UPDATE metric_observations SET review_status = 'rejected' WHERE research_run_id = ${runId}`;
    assert.equal((await validatePointInTime(runId)).valid, true, 'rejected audit rows are not research inputs');
  } finally {
    await sql`DELETE FROM metric_observations WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM metric_definitions WHERE metric_key = ${metricKey}`;
    await sql`DELETE FROM source_gaps WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM evidence_links WHERE evidence_claim_id = ${claimId}`;
    await sql`DELETE FROM source_locations WHERE source_document_id = ${sourceId}`;
    await sql`DELETE FROM evidence_claims WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_run_sources WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM source_documents WHERE id = ${sourceId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
  }
});

test("report artifacts round-trip and version on a Drizzle-shared connection", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  const sql = postgres(process.env.DATABASE_URL!);
  drizzle(sql);
  const runId = crypto.randomUUID();
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version)
      VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 3)`;
    const ctx = { runId, assetId: asset.id, assetSlug: 'persistence-fixture' };
    const content = { tables: [{ label: "Owner's equity — USD", values: [0, -1.5, null] }], coverage: { complete: true } };
    const first = await saveReportArtifact(sql, ctx, 'financial_statement_set', 'fixture', content);
    assert.deepEqual(first.content_json, content);
    const unchanged = await saveReportArtifact(sql, ctx, 'financial_statement_set', 'fixture', content);
    assert.equal(unchanged.id, first.id);
    await sql`UPDATE research_artifacts SET status = 'needs_more_work' WHERE id = ${first.id}`;
    const regenerated = await saveReportArtifact(sql, ctx, 'financial_statement_set', 'fixture', content);
    assert.equal(regenerated.status, 'validated');
    assert.equal(regenerated.artifact_version, 2, 'regenerated invalidated content needs a current validated version');
    assert.equal(regenerated.supersedes_artifact_id, first.id);
    const revised = await saveReportArtifact(sql, ctx, 'financial_statement_set', 'fixture', { ...content, revision: 2 });
    assert.equal(revised.artifact_version, 3);
    assert.equal(revised.supersedes_artifact_id, regenerated.id);
    const [prior] = await sql`SELECT status FROM research_artifacts WHERE id = ${first.id}`;
    assert.equal(prior.status, 'superseded');
  } finally {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
  }
});

test("JSONB task-style outputs survive object and legacy-string persistence and group merging", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    await sql`CREATE TEMP TABLE harness_output_test (id serial PRIMARY KEY, output_json jsonb)`;
    const objectOutput = { analysis_sections: [{ section_key: "commerce" }], confidence: 0.9 };
    const legacyOutput = JSON.stringify({ analysis_sections: [{ section_key: "fintech" }], confidence: 0.8 });
    await sql`INSERT INTO harness_output_test (output_json) VALUES (${sql.json(objectOutput as any)}), (${legacyOutput}::jsonb)`;
    const rows = await sql`SELECT output_json FROM harness_output_test ORDER BY id`;
    const merged = mergeGroupOutputs(rows.map((row) => row.output_json as any));
    assert.deepEqual(merged.analysis_sections.map((section: any) => section.section_key), ["commerce", "fintech"]);
    assert.equal(merged.confidence, 0.85);
  } finally { await sql.end(); }
});

test("model-call attempts persist structured audit metadata", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL!);
  let callId: string | undefined;
  try {
    callId = await recordModelCall({
      modelProvider: "integration-fixture", modelName: "fixture-model", modelTier: "mid", status: "success",
      inputTokens: 7, outputTokens: 11, costUsd: 0, latencyMs: 13,
      requestMetadata: { attempt: 2, fallback: true, compaction_occurred: true },
      responseMetadata: {
        request_id: "fixture-request", repair_attempted: true, timeout_type: null,
        validation_errors: [], raw_response_excerpt: "{\"ok\":true}", tool_calls: [],
      },
    });
    const [row] = await sql`SELECT request_metadata_json, response_metadata_json FROM model_call_logs WHERE id = ${callId}`;
    assert.equal(row.request_metadata_json.attempt, 2);
    assert.equal(row.request_metadata_json.fallback, true);
    assert.equal(row.response_metadata_json.request_id, "fixture-request");
    assert.equal(row.response_metadata_json.repair_attempted, true);
    assert.deepEqual(row.response_metadata_json.validation_errors, []);
  } finally {
    if (callId) {
      await sql`DELETE FROM model_budget_ledger WHERE model_call_log_id = ${callId}`;
      await sql`DELETE FROM model_call_logs WHERE id = ${callId}`;
    }
    await sql.end();
  }
});

test("idempotent task resume and terminal failure leave no running work or valuation stage", { skip: process.env.RUN_DB_INTEGRATION !== "1" }, async () => {
  loadLocalEnv();
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL!);
  const runId = crypto.randomUUID();
  let taskId: string | undefined;
  try {
    const [asset] = await sql`SELECT id FROM assets ORDER BY created_at LIMIT 1`;
    assert.ok(asset?.id, "At least one seeded asset is required");
    await sql`
      INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version)
      VALUES (${runId}, ${asset.id}, 'deep_dive', 'running', 2)
    `;
    const [analysis] = await sql`
      INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'asset_analysis', 1, 'running') RETURNING id
    `;
    await sql`
      INSERT INTO research_stages (research_run_id, stage_key, stage_order, status)
      VALUES (${runId}, 'asset_valuation', 2, 'pending')
    `;
    taskId = await enqueueTask({
      runId, stageId: analysis.id, taskKey: "analysis-fixture", taskType: "analysis",
      agentName: "asset-analyst", inputJson: { packet: "fixture" },
    });
    const resumedTaskId = await enqueueTask({
      runId, stageId: analysis.id, taskKey: "analysis-fixture", taskType: "analysis",
      agentName: "asset-analyst", inputJson: { packet: "fixture" },
    });
    assert.equal(resumedTaskId, taskId);
    await sql`UPDATE research_tasks SET status = 'running', started_at = NOW() WHERE id = ${taskId}`;

    await failRun(runId, "integration analysis failure");

    const [running] = await sql`SELECT count(*)::int count FROM research_tasks WHERE research_run_id = ${runId} AND status = 'running'`;
    const [valuation] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'asset_valuation'`;
    const [task] = await sql`SELECT status, completed_at FROM research_tasks WHERE id = ${taskId}`;
    assert.equal(running.count, 0);
    assert.equal(valuation.status, "cancelled");
    assert.equal(task.status, "failed");
    assert.ok(task.completed_at);
  } finally {
    await sql`DELETE FROM research_tasks WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql.end();
  }
});
