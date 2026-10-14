// Research memory phase 2: embedding configuration, citation extraction, and graph edge cases
// beyond the plan's acceptance tests.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "../src/db";
import { citedClaimIds, cosineSimilarity, getEmbeddingProvider, retrievePassages } from "../src/lib/research/memory";
import { persistEvidence, storeDiscoveredSources } from "../src/lib/research/sources/corpus";
import { createArtifactRepository } from "../src/lib/research/artifacts/repository";
import { STAGE_CONFIGS } from "../src/lib/workflow/stages";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
delete process.env.RESEARCH_EMBEDDING_PROVIDER;
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

const claimA = randomUUID(), claimB = randomUUID();

test("cited claim ids come from citation keys at any depth, deduplicated, UUIDs only", () => {
  const content = {
    evidence_ids: [claimA, "E1", claimA.toUpperCase()],
    sections: [{ body: claimB, nested: { supporting_claim_ids: { primary: claimB } } }],
    other_ids: [randomUUID()],
  };
  assert.deepEqual(citedClaimIds(content), [claimA, claimB].sort());
  assert.deepEqual(citedClaimIds({ claim_ids: "not-a-uuid" }), []);
  assert.deepEqual(citedClaimIds(null), []);
});

test("embedding endpoints must be HTTPS without credentials, query or fragment, and errors never show the key", () => {
  const env = { RESEARCH_EMBEDDING_PROVIDER: "openai-compatible", RESEARCH_EMBEDDING_BASE_URL: "https://embed.example/v1",
    RESEARCH_MODEL_ALLOWED_HOSTS: "embed.example", RESEARCH_EMBEDDING_MODEL: "m", RESEARCH_EMBEDDING_API_KEY: "key-should-stay-hidden" };
  for (const [url, pattern] of [["https://user:pw@embed.example/v1", /credentials/], ["https://embed.example/v1?x=1", /query/],
    ["not a url", /valid URL/]] as const) {
    assert.throws(() => getEmbeddingProvider({ ...env, RESEARCH_EMBEDDING_BASE_URL: url }),
      (e: Error) => pattern.test(e.message) && e.message.includes("RESEARCH_EMBEDDING_BASE_URL") && !e.message.includes("key-should-stay-hidden"));
  }
  assert.throws(() => getEmbeddingProvider({ ...env, RESEARCH_EMBEDDING_COST_PER_MILLION_TOKENS: "-1" }), /RESEARCH_EMBEDDING_COST_PER_MILLION_TOKENS/);
  assert.equal(getEmbeddingProvider({ ...env, RESEARCH_EMBEDDING_PROVIDER: " None " }), null);
});

test("the mock provider places similar wording closer than unrelated wording", async () => {
  const mock = getEmbeddingProvider({ RESEARCH_EMBEDDING_PROVIDER: "mock" })!;
  const { vectors: [query, near, far] } = await mock.embed(["who founded the marketplace", "the founder started the marketplace", "credit card delinquency rates"]);
  assert.ok(cosineSimilarity(query, near) > cosineSimilarity(query, far));
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0, "vectors of different length are not compared");
});

async function fixture(sql: postgres.Sql) {
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { runId, runType: "deep_dive", assetId, assetName: "Graph Fixture Co", assetSlug: `graph-${assetId.slice(0, 8)}`, symbol: "GRPH",
    profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency) VALUES (${assetId}, ${ctx.assetName}, ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version, budget_limit_usd)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3, 10)`;
  for (const [order, stage] of STAGE_CONFIGS.entries()) {
    await sql`INSERT INTO research_stages (research_run_id, stage_key, stage_order, status) VALUES (${runId}, ${stage.key}, ${order}, 'completed')`;
  }
  const sections = Array.from({ length: 6 }, (_, i) => `Section ${i + 1}\n\nMerchant payments grew in region ${i + 1} for ${runId}.`);
  sections.push("Archive\n\nA lighthouse keeper logged the weather every night.");
  const [stored] = await storeDiscoveredSources(sql, ctx as any, [{ sourceType: "web_industry_primary", title: "Regional review", publisher: "graph.example",
    url: `https://graph.example/${randomUUID()}`, content: sections.join("\n\n"), mimeType: "text/plain", qualityScore: "0.9", publishedAt: "2026-09-01",
    periodEnd: null, metadata: { source_role: "industry_primary", system_generated: true }, chunkTitle: "Regional review" }] as any);
  const chunks = await sql`SELECT dc.id, dc.section_title FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id
    WHERE dc.source_document_id = ${stored.sourceId} AND dp.parser_name = 'research-memory'`;
  const chunk = (title: string) => String(chunks.find(c => c.section_title === title)!.id);
  const claim = (text: string, title: string) => ({ claim_text: text, claim_type: "industry", claim_category: "fact", confidence: 0.8,
    source_id: stored.sourceId, document_chunk_id: chunk(title) });
  const idOf = async (text: string) => String((await sql`SELECT id FROM evidence_claims WHERE research_run_id = ${runId} AND claim_text = ${text}`)[0].id);
  const cleanup = async () => {
    for (let pass = 0; pass < 4; pass++) {
      await sql`DELETE FROM research_artifact_claim_links WHERE artifact_id IN (SELECT id FROM research_artifacts WHERE research_run_id = ${runId})`.catch(() => undefined);
      await sql`DELETE FROM claim_relationships WHERE from_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ${runId})`.catch(() => undefined);
      await sql`DELETE FROM evidence_links WHERE evidence_claim_id IN (SELECT id FROM evidence_claims WHERE research_run_id = ${runId})`.catch(() => undefined);
      for (const table of ["research_artifacts", "evidence_claims", "research_run_sources", "research_stages", "model_budget_ledger", "model_call_logs"]) {
        await sql`DELETE FROM ${sql(table)} WHERE research_run_id = ${runId}`.catch(() => undefined);
      }
      for (const table of ["source_locations", "document_chunks", "document_parses", "source_role_assignments"]) {
        await sql`DELETE FROM ${sql(table)} WHERE source_document_id = ${stored.sourceId}`.catch(() => undefined);
      }
      await sql`DELETE FROM source_documents WHERE id = ${stored.sourceId}`.catch(() => undefined);
      await sql`DELETE FROM research_runs WHERE id = ${runId}`.catch(() => undefined);
    }
    await sql`DELETE FROM assets WHERE id = ${assetId}`.catch(() => undefined);
  };
  return { ctx, stored, claim, idOf, cleanup };
}

test("a contradiction named in either order is one edge", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql);
  try {
    const a = "Merchant payments grew in region 1.", b = "Merchant payments grew in region 2.";
    const output = (texts: string[]) => ({ evidence_claims: [f.claim(a, "Section 1"), f.claim(b, "Section 2")],
      contradictions: [{ claim_texts: texts, description: "Growth figures disagree", confidence: "0.4" }] });
    await persistEvidence(sql, f.ctx as any, [f.stored], output([a, b]));
    await persistEvidence(sql, f.ctx as any, [f.stored], output([` ${b.toUpperCase()} `, a]));
    const edges = await sql`SELECT cr.confidence, cr.description FROM claim_relationships cr JOIN evidence_claims ec ON ec.id = cr.from_claim_id
      WHERE ec.research_run_id = ${f.ctx.runId}`;
    assert.equal(edges.length, 1);
    assert.equal(Number(edges[0].confidence), 0.4);
    assert.equal(edges[0].description, "Growth figures disagree");
  } finally { await f.cleanup(); await sql.end(); }
});

test("graph-only passages keep a slot when keyword matches fill the limit", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql);
  try {
    const archived = "A lighthouse keeper logged the weather.";
    await persistEvidence(sql, f.ctx as any, [f.stored], { evidence_claims: [f.claim(archived, "Archive")] });
    const need = { key: "payments", query: "merchant payments region", maxPassages: 4, seedClaimIds: [await f.idOf(archived)] };
    const { passages } = await retrievePassages(sql, { runId: f.ctx.runId, need });
    assert.equal(passages.length, 4);
    assert.deepEqual(passages.map(p => p.matched), ["keyword", "keyword", "keyword", "graph"]);
    assert.equal(passages.at(-1)!.section_path.at(-1), "Archive");
  } finally { await f.cleanup(); await sql.end(); }
});

test("a revised artifact links only the citations it makes and supersedes the prior version", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql);
  try {
    const a = "Merchant payments grew in region 3.", b = "Merchant payments grew in region 4.";
    await persistEvidence(sql, f.ctx as any, [f.stored], { evidence_claims: [f.claim(a, "Section 3"), f.claim(b, "Section 4")] });
    const [c1, c2] = [await f.idOf(a), await f.idOf(b)];
    const repo = createArtifactRepository(drizzle(sql, { schema }));
    const save = (ids: string[]) => repo.upsertArtifact({ research_run_id: f.ctx.runId, asset_id: f.ctx.assetId, artifact_type: "graph_fixture", scope_key: "x",
      status: "draft", content_json: { claim_ids: ids }, schema_version: "1", validator_version: "1", prompt_version: "test", created_by: "test" });
    const first = await save([c1]);
    const second = await save([c2]);
    assert.notEqual(first.id, second.id);
    assert.equal(second.supersedes_artifact_id, first.id);
    const [prior] = await sql`SELECT status FROM research_artifacts WHERE id = ${first.id}`;
    assert.equal(prior.status, "superseded");
    const linked = (await sql`SELECT evidence_claim_id FROM research_artifact_claim_links WHERE artifact_id = ${second.id}`).map(r => String(r.evidence_claim_id));
    assert.deepEqual(linked, [c2]);
  } finally { await f.cleanup(); await sql.end(); }
});
