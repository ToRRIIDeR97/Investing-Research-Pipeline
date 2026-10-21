// A specialist call reads only its dependency types and skips the input hash it discards (audit M8).
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadReportInputs } from "../src/lib/research/reporting/store";
import { persistEvidence, storeDiscoveredSources } from "../src/lib/research/sources/corpus";
import { cleanup, createRun } from "../Implementations/research-request-routing/acceptance/fixtures";

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

// GAP-3-2: a NULL published_at failed `published_at <= cutoff`, so undated documents (industry reports, peer PDFs)
// never reached a packet. Only a point-in-time run, where an undated page may postdate the cutoff, still drops them.
test("loadReportInputs keeps evidence from undated documents except in point-in-time runs", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const run = await createRun(sql);
  try {
    await sql`UPDATE research_runs SET source_cutoff_at = created_at WHERE id = ${run.runId}`;
    const ctx = { runId: run.runId, runType: "deep_dive", assetId: run.assetId, assetName: run.assetName, assetSlug: run.assetSlug,
      symbol: run.symbol, profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 } as any;
    const doc = (title: string, publishedAt: string | null) => ({ sourceType: "web_industry_primary", title, publisher: "fixture.example",
      url: `https://fixture.example/${randomUUID()}`, content: `${title}: U.S. internet advertising revenues increased 13.9%. ${run.runId}`,
      mimeType: "text/plain", qualityScore: "0.9", publishedAt, periodEnd: null,
      metadata: { source_role: "industry_primary", system_generated: true }, chunkTitle: title });
    const stored = await storeDiscoveredSources(sql, ctx, [doc("Dated report", "2026-09-01"), doc("Undated report", null)] as any);
    for (const source of stored) {
      const [chunk] = await sql`SELECT dc.id FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id
        WHERE dc.source_document_id = ${source.sourceId} AND dp.parser_name = 'research-memory' LIMIT 1`;
      await persistEvidence(sql, ctx, [source], { evidence_claims: [{ claim_text: `Ad revenue grew 13.9% (${source.title}).`, claim_type: "industry",
        claim_category: "fact", confidence: 0.8, source_id: source.sourceId, document_chunk_id: String(chunk.id) }] });
    }
    const cutoff = new Date().toISOString();
    const titles = async () => (await loadReportInputs(sql as any, run.runId, cutoff)).evidence.map(e => `${e.source_title}:${e.published_at}`).sort();
    assert.deepEqual(await titles(), ["Dated report:2026-09-01T00:00:00.000Z", "Undated report:null"]);
    await sql`UPDATE research_runs SET run_type = 'backtest_only' WHERE id = ${run.runId}`;
    assert.deepEqual(await titles(), ["Dated report:2026-09-01T00:00:00.000Z"], "a backtest drops undated documents");
    await sql`UPDATE research_runs SET run_type = 'deep_dive', source_cutoff_at = created_at - INTERVAL '30 days' WHERE id = ${run.runId}`;
    assert.deepEqual(await titles(), ["Dated report:2026-09-01T00:00:00.000Z"], "so does a run with a past source cutoff");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
