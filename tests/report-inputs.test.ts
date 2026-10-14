// A specialist call reads only its dependency types and skips the input hash it discards (audit M8).
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadReportInputs } from "../src/lib/research/reporting/store";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

test("loadReportInputs filters by type and skips the fingerprint and evidence on request", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const assetId = randomUUID(), runId = randomUUID();
  try {
    await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency) VALUES (${assetId}, 'Inputs Fixture', ${`inputs-${assetId.slice(0, 8)}`}, 'equity', 'active', 'USD')`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version) VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3)`;
    for (const type of ["business_model", "moat_assessment", "valuation_summary"]) {
      await sql`INSERT INTO research_artifacts (research_run_id, asset_id, artifact_type, scope_key, status, content_json, created_by)
        VALUES (${runId}, ${assetId}, ${type}, 'run', 'validated', ${sql.json({ type })}, 'test')`;
    }
    const cutoff = "2026-10-01T00:00:00.000Z";
    const all = await loadReportInputs(sql as any, runId, cutoff);
    assert.equal(all.artifacts.length, 3);
    assert.match(all.input_hash, /^[0-9a-f]{64}$/);
    const some = await loadReportInputs(sql as any, runId, cutoff, { types: ["moat_assessment", "valuation_summary"], fingerprint: false, evidence: false });
    assert.deepEqual(some.artifacts, all.artifacts.filter(a => ["moat_assessment", "valuation_summary"].includes(a.artifact_type)),
      "the same rows in the same order as filtering the full set");
    assert.equal(some.input_hash, "");
    assert.deepEqual(some.evidence, []);
    assert.deepEqual((await loadReportInputs(sql as any, runId, cutoff, { types: [] })).artifacts, []);
  } finally {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  }
});
