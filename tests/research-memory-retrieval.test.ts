// Research-memory retrieval fixes from the 2026-10-11 audit: period hints and recency (RMEM1), the stored
// search vector (RMEM2), the passage scope (RMEM4), text-table parsing (RMEM5) and per-run metadata (RMEM10).
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { retrievePassages } from "../src/lib/research/memory";
import { storeDiscoveredSources } from "../src/lib/research/sources/corpus";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
delete process.env.RESEARCH_EMBEDDING_PROVIDER;
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

type Run = { runId: string; assetId: string; ctx: Record<string, unknown> };

async function newRun(sql: postgres.Sql, assetName = "Retrieval Fixture Co"): Promise<Run> {
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { runId, runType: "deep_dive", assetId, assetName, assetSlug: `retrieval-${assetId.slice(0, 8)}`, symbol: "RTRV",
    profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency) VALUES (${assetId}, ${assetName}, ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3, 10)`;
  return { runId, assetId, ctx };
}

async function store(sql: postgres.Sql, run: Run, doc: { title: string; content: string; role?: string; sourceType?: string; url?: string;
  periodEnd?: string | null; publishedAt?: string | null; mimeType?: string; metadata?: Record<string, unknown> }) {
  const [stored] = await storeDiscoveredSources(sql, run.ctx as any, [{ sourceType: doc.sourceType || `web_${doc.role}`, title: doc.title,
    publisher: "retrieval.example", url: doc.url || `https://retrieval.example/${randomUUID()}`, content: doc.content, mimeType: doc.mimeType || "text/plain",
    qualityScore: "0.9", publishedAt: doc.publishedAt ?? null, periodEnd: doc.periodEnd ?? null,
    metadata: doc.metadata || { source_role: doc.role, system_generated: true }, chunkTitle: doc.title }] as any);
  return String(stored.sourceId);
}

async function removeRuns(sql: postgres.Sql, runs: Run[]) {
  const runIds = runs.map(r => r.runId), assetIds = runs.map(r => r.assetId);
  const docs = sql`SELECT id FROM source_documents WHERE research_run_id = ANY(${runIds}::uuid[])
    OR id IN (SELECT source_document_id FROM research_run_sources WHERE research_run_id = ANY(${runIds}::uuid[]))`;
  const ids = (await docs).map(row => String(row.id));
  await sql`DELETE FROM research_run_sources WHERE research_run_id = ANY(${runIds}::uuid[]) OR source_document_id = ANY(${ids}::uuid[])`;
  for (const table of ["source_locations", "document_chunks", "document_parses", "source_role_assignments"]) {
    await sql`DELETE FROM ${sql(table)} WHERE source_document_id = ANY(${ids}::uuid[])`;
  }
  await sql`DELETE FROM source_documents WHERE id = ANY(${ids}::uuid[])`;
  await sql`DELETE FROM research_runs WHERE id = ANY(${runIds}::uuid[])`;
  await sql`DELETE FROM assets WHERE id = ANY(${assetIds}::uuid[])`;
}

test("research-memory passages store their search vector; raw payload chunks do not", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const id = await store(sql, run, { title: "Industry review", role: "industry_primary", content: `Market Structure\n\nAcquirers compete on merchant pricing. ${run.runId}` });
    const rows = await sql`SELECT dp.parser_name, dc.search_tsv IS NOT NULL AS indexed, ts_filter(dc.search_tsv, '{a}') AS section
      FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id WHERE dc.source_document_id = ${id} ORDER BY dp.parser_name`;
    assert.deepEqual(rows.map(r => [r.parser_name, r.indexed]), [["research-memory", true], ["system-source-payload", false]]);
    assert.match(String(rows[0].section), /'market':\d+A/, "the section path is weighted A");
    const result = await retrievePassages(sql, { runId: run.runId, need: { key: "pricing", query: "merchant pricing", sourceRoles: ["industry_primary"] } });
    assert.equal(result.passages.length, 1);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});
