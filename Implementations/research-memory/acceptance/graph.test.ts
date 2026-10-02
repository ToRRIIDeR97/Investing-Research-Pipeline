import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "../../../src/db";
import { persistEvidence, storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import { createArtifactRepository } from "../../../src/lib/research/artifacts/repository";
import { getAgentConfig } from "../../../src/lib/agent-harness/registry";
import { cleanup, corpusCtx, createRun, loadEnv, loadMemory, payload, skipDb as skip, type Ctx } from "./fixtures";

loadEnv();
delete process.env.RESEARCH_EMBEDDING_PROVIDER;

function scripted(map: (text: string) => number[], options: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  return { calls, provider: { id: "scripted", model: "scripted-v1", dimensions: 2, async embed(texts: string[]) {
    calls.push(texts);
    if (options.fail) throw new Error("embedding endpoint unavailable");
    return { vectors: texts.map(map), inputTokens: texts.join(" ").length, costUsd: 0 };
  } } };
}

const companyPage = (nonce: string) => [
  "Leadership", "", `Marcos Galperín wrote the business plan in 1999 and assembled the first team. Fixture ${nonce}.`, "",
  "Products", "", "The company was started as a marketplace listing service for used goods.", "",
  "Funding", "", "Early funding came from venture investors in two rounds.",
].join("\n");

async function storeCompanyPage(sql: postgres.Sql, run: Ctx) {
  const [stored] = await storeDiscoveredSources(sql, corpusCtx(run) as any, [
    payload({ title: "Company page", content: companyPage(run.runId), mimeType: "text/plain", role: "company_investor_relations" }),
  ]);
  const chunks = await sql`SELECT dc.id, dc.section_title FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id
    WHERE dc.source_document_id = ${stored.sourceId} AND dp.parser_name = 'research-memory' ORDER BY dc.chunk_index`;
  const chunk = (title: string) => String(chunks.find(c => c.section_title === title)!.id);
  return { stored, chunk };
}

const claim = (text: string, sourceId: string, chunkId: string) =>
  ({ claim_text: text, claim_type: "company_history", claim_category: "fact", confidence: 0.8, source_id: sourceId, document_chunk_id: chunkId });

const claimId = async (sql: postgres.Sql, runId: string, text: string) =>
  String((await sql`SELECT id FROM evidence_claims WHERE research_run_id = ${runId} AND claim_text = ${text}`)[0].id);

test("AC-7: embedding configuration is off by default and names the missing variable", async () => {
  const { getEmbeddingProvider } = loadMemory();
  assert.equal(getEmbeddingProvider({}), null);
  assert.equal(getEmbeddingProvider({ RESEARCH_EMBEDDING_PROVIDER: "none" }), null);
  const mock = getEmbeddingProvider({ RESEARCH_EMBEDDING_PROVIDER: "mock" });
  const [a, b] = await Promise.all([mock.embed(["same text"]), mock.embed(["same text"])]);
  assert.deepEqual(a.vectors, b.vectors);
  const base = { RESEARCH_EMBEDDING_PROVIDER: "openai-compatible", RESEARCH_EMBEDDING_BASE_URL: "https://embed.example/v1",
    RESEARCH_MODEL_ALLOWED_HOSTS: "embed.example", RESEARCH_EMBEDDING_MODEL: "text-embed-1", RESEARCH_EMBEDDING_API_KEY: "secret-key-123" };
  assert.throws(() => getEmbeddingProvider({ ...base, RESEARCH_EMBEDDING_BASE_URL: undefined }), /RESEARCH_EMBEDDING_BASE_URL/);
  assert.throws(() => getEmbeddingProvider({ ...base, RESEARCH_EMBEDDING_MODEL: undefined }), /RESEARCH_EMBEDDING_MODEL/);
  assert.throws(() => getEmbeddingProvider({ ...base, RESEARCH_EMBEDDING_API_KEY: undefined }), /RESEARCH_EMBEDDING_API_KEY/);
  assert.throws(() => getEmbeddingProvider({ ...base, RESEARCH_MODEL_ALLOWED_HOSTS: "other.example" }), (e: Error) => !e.message.includes("secret-key-123"));
  assert.throws(() => getEmbeddingProvider({ ...base, RESEARCH_EMBEDDING_PROVIDER: "carrier-pigeon" }));
});

test("AC-7: the openai-compatible provider posts batches to <base>/embeddings", async () => {
  const { getEmbeddingProvider } = loadMemory();
  const original = globalThis.fetch;
  const seen: Array<{ url: string; auth: string | null; body: any }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = getEmbeddingProvider({ RESEARCH_EMBEDDING_PROVIDER: "openai-compatible", RESEARCH_EMBEDDING_BASE_URL: "https://embed.example/v1",
      RESEARCH_MODEL_ALLOWED_HOSTS: "embed.example", RESEARCH_EMBEDDING_MODEL: "text-embed-1", RESEARCH_MODEL_API_KEY: "k-456" });
    const result = await provider.embed(["first", "second"]);
    assert.equal(seen[0].url, "https://embed.example/v1/embeddings");
    assert.equal(seen[0].auth, "Bearer k-456");
    assert.deepEqual(seen[0].body.input, ["first", "second"]);
    assert.equal(seen[0].body.model, "text-embed-1");
    assert.deepEqual(result.vectors, [[1, 0], [0, 1]], "vectors follow input order");
    assert.equal(result.inputTokens, 7);
  } finally { globalThis.fetch = original; }
});

test("AC-8: passages get one embedding per model in batches of at most 64, with each call in the ledger", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const sections = Array.from({ length: 70 }, (_, i) => `Section ${i + 1}\n\nDistinct body for section ${i + 1} of the annual review ${run.runId}.`).join("\n\n");
    const [stored] = await storeDiscoveredSources(sql, corpusCtx(run) as any, [payload({ title: "Annual review", content: sections, mimeType: "text/plain", role: "industry_primary" })]);
    const { ensureDocumentIndexed } = loadMemory();
    const embedder = scripted(text => [text.length % 7, 1]);
    await ensureDocumentIndexed(sql, { sourceId: stored.sourceId, runId: run.runId, embeddings: embedder.provider });
    const [{ passages }] = await sql`SELECT COUNT(*)::int AS passages FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id
      WHERE dc.source_document_id = ${stored.sourceId} AND dp.parser_name = 'research-memory'`;
    const [{ vectors }] = await sql`SELECT COUNT(*)::int AS vectors FROM document_embeddings de JOIN document_chunks dc ON dc.id = de.document_chunk_id
      WHERE dc.source_document_id = ${stored.sourceId} AND de.embedding_model = 'scripted-v1'`;
    assert.ok(passages >= 70);
    assert.equal(vectors, passages);
    assert.ok(embedder.calls.every(batch => batch.length <= 64));
    const logs = await sql`SELECT model_provider, model_name FROM model_call_logs WHERE research_run_id = ${run.runId} AND agent_name = 'embedder'`;
    assert.equal(logs.length, embedder.calls.length);
    assert.ok(logs.every(l => l.model_provider === "scripted" && l.model_name === "scripted-v1"));
    await ensureDocumentIndexed(sql, { sourceId: stored.sourceId, runId: run.runId, embeddings: embedder.provider });
    const [{ again }] = await sql`SELECT COUNT(*)::int AS again FROM document_embeddings de JOIN document_chunks dc ON dc.id = de.document_chunk_id
      WHERE dc.source_document_id = ${stored.sourceId}`;
    assert.equal(again, passages, "re-indexing adds no embeddings");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-8: a failing embedding provider leaves the document keyword-indexed with a recorded warning", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const { stored } = await storeCompanyPage(sql, run);
    const { ensureDocumentIndexed } = loadMemory();
    const result = await ensureDocumentIndexed(sql, { sourceId: stored.sourceId, runId: run.runId, embeddings: scripted(() => [1, 0], { fail: true }).provider });
    assert.ok(result.warnings.some((w: string) => /embedding endpoint unavailable/.test(w)));
    const [parse] = await sql`SELECT warnings_json FROM document_parses WHERE source_document_id = ${stored.sourceId} AND parser_name = 'research-memory'`;
    assert.match(JSON.stringify(parse.warnings_json), /embedding endpoint unavailable/);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-9: hybrid ranking returns the nearest vector without a keyword match and ignores other models", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const { stored, chunk } = await storeCompanyPage(sql, run);
    const { ensureDocumentIndexed, retrievePassages } = loadMemory();
    const embedder = scripted(text => /Galper|who started the company/.test(text) ? [1, 0] : [0, 1]);
    await ensureDocumentIndexed(sql, { sourceId: stored.sourceId, runId: run.runId, embeddings: embedder.provider });
    await sql`INSERT INTO document_embeddings (document_chunk_id, embedding_model, embedding_dimension, embedding)
      VALUES (${chunk("Products")}, 'other-model', 2, '[1, 0]'::jsonb)`;
    const need = { key: "origin", query: "who started the company", sourceRoles: ["company_investor_relations"] };
    const result = await retrievePassages(sql, { runId: run.runId, need, embeddings: embedder.provider });
    assert.equal(result.ranking, "hybrid");
    const leadership = result.passages.find((p: any) => p.section_path.at(-1) === "Leadership");
    const products = result.passages.find((p: any) => p.section_path.at(-1) === "Products");
    assert.equal(leadership?.matched, "vector");
    assert.equal(products?.matched, "keyword");
    const again = await retrievePassages(sql, { runId: run.runId, need, embeddings: embedder.provider });
    assert.deepEqual(again.passages.map((p: any) => p.passage_id), result.passages.map((p: any) => p.passage_id));
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-10: saved artifacts link the run's claims they cite, at any depth, once", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql), other = await createRun(sql);
  try {
    const { stored, chunk } = await storeCompanyPage(sql, run);
    const texts = ["Marcos Galperín wrote the business plan in 1999.", "The company was started as a marketplace listing service."];
    await persistEvidence(sql, corpusCtx(run) as any, [stored], { evidence_claims: [claim(texts[0], stored.sourceId, chunk("Leadership")), claim(texts[1], stored.sourceId, chunk("Products"))] });
    const otherPage = await storeCompanyPage(sql, other);
    await persistEvidence(sql, corpusCtx(other) as any, [otherPage.stored], { evidence_claims: [claim("A claim that belongs to another research run.", otherPage.stored.sourceId, otherPage.chunk("Funding"))] });
    const [c1, c2] = await Promise.all(texts.map(t => claimId(sql, run.runId, t)));
    const foreign = await claimId(sql, other.runId, "A claim that belongs to another research run.");
    const content = { sections: [{ id: "s1", evidence_ids: [c1, foreign, "not-a-claim"] }], meta: { supporting_claim_ids: [c2] } };
    const saved = await saveReportArtifact(sql, run, "memory_fixture", "s1", content);
    const links = async (artifactId: string) => (await sql`SELECT evidence_claim_id, support_type FROM research_artifact_claim_links WHERE artifact_id = ${artifactId}`)
      .map(r => `${r.evidence_claim_id}:${r.support_type}`).sort();
    assert.deepEqual(await links(saved.id), [`${c1}:cites`, `${c2}:cites`].sort());
    await saveReportArtifact(sql, run, "memory_fixture", "s1", content);
    assert.deepEqual(await links(saved.id), [`${c1}:cites`, `${c2}:cites`].sort());
    const repo = createArtifactRepository(drizzle(sql, { schema }));
    const repoArtifact = await repo.upsertArtifact({ research_run_id: run.runId, asset_id: run.assetId, artifact_type: "memory_fixture_repo",
      scope_key: "repo", status: "validated", content_json: { rows: [{ evidence_claim_ids: [c1] }] }, schema_version: "1", validator_version: "1",
      prompt_version: "test", created_by: "test" });
    assert.deepEqual(await links(repoArtifact.id), [`${c1}:cites`]);
  } finally { await cleanup(sql, [run.runId, other.runId], [run.assetId, other.assetId]); await sql.end(); }
});

test("AC-11: source-reader contradictions between stored claims become reviewed-later edges", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const { stored, chunk } = await storeCompanyPage(sql, run);
    const a = "Marcos Galperín wrote the business plan in 1999.", b = "Early funding came from venture investors in two rounds.";
    const output = {
      evidence_claims: [claim(a, stored.sourceId, chunk("Leadership")), claim(b, stored.sourceId, chunk("Funding"))],
      contradictions: [
        { claim_texts: [a, b], description: "Timeline conflict between plan and funding", confidence: 0.6 },
        { claim_texts: [a, b], description: "No confidence given" },
        { claim_texts: [a, "A claim that was never stored anywhere."], description: "Unknown claim", confidence: 0.9 },
      ],
    };
    await persistEvidence(sql, corpusCtx(run) as any, [stored], output);
    const edges = async () => sql`SELECT cr.* FROM claim_relationships cr JOIN evidence_claims ec ON ec.id = cr.from_claim_id WHERE ec.research_run_id = ${run.runId}`;
    const [edge, ...rest] = await edges();
    assert.equal(rest.length, 0);
    assert.equal(edge.relationship_type, "contradicts");
    assert.equal(Number(edge.confidence), 0.6);
    assert.equal(edge.extractor, "source-reader");
    assert.equal(edge.extractor_version, getAgentConfig("source-reader").promptVersion);
    assert.equal(edge.review_status, "unreviewed");
    assert.equal(edge.evidence_location_ids.length, 2);
    await persistEvidence(sql, corpusCtx(run) as any, [stored], output);
    assert.equal((await edges()).length, 1, "persisting again adds no edge");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-12: claim and artifact seeds pull in their passages and one hop of unrejected edges", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const { stored, chunk } = await storeCompanyPage(sql, run);
    const a = "Marcos Galperín wrote the business plan in 1999.", b = "Early funding came from venture investors in two rounds.";
    await persistEvidence(sql, corpusCtx(run) as any, [stored], {
      evidence_claims: [claim(a, stored.sourceId, chunk("Leadership")), claim(b, stored.sourceId, chunk("Funding"))],
      contradictions: [{ claim_texts: [a, b], description: "Timeline conflict", confidence: 0.7 }],
    });
    const c1 = await claimId(sql, run.runId, a);
    const { retrievePassages } = loadMemory();
    const need = { key: "seeded", query: "zebra migration patterns", seedClaimIds: [c1] };
    const seeded = await retrievePassages(sql, { runId: run.runId, need });
    const titles = seeded.passages.map((p: any) => p.section_path.at(-1)).sort();
    assert.deepEqual(titles, ["Funding", "Leadership"]);
    assert.ok(seeded.passages.every((p: any) => p.matched === "graph"));
    await sql`UPDATE claim_relationships SET review_status = 'rejected' WHERE from_claim_id = ${c1} OR to_claim_id = ${c1}`;
    const rejected = await retrievePassages(sql, { runId: run.runId, need });
    assert.deepEqual(rejected.passages.map((p: any) => p.section_path.at(-1)), ["Leadership"]);
    const artifact = await saveReportArtifact(sql, run, "memory_fixture", "seed", { evidence_ids: [c1] });
    const viaArtifact = await retrievePassages(sql, { runId: run.runId, need: { key: "artifact", query: "zebra migration patterns", seedArtifactIds: [artifact.id] } });
    assert.deepEqual(viaArtifact.passages.map((p: any) => p.section_path.at(-1)), ["Leadership"]);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
