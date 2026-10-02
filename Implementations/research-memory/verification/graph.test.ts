import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { persistEvidence, storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { saveReportArtifact } from "../../../src/lib/research/reporting/store";
import { corpusContext, loadEnv, memory, newRun, removeRuns, sections, skipDb as skip, source, type Run } from "./fixtures";

loadEnv();
delete process.env.RESEARCH_EMBEDDING_PROVIDER;

const provider = (model: string, map: (t: string) => number[]) => {
  const calls: string[][] = [];
  return { calls, embeddings: { id: "verify", model, dimensions: 2, async embed(texts: string[]) { calls.push(texts); return { vectors: texts.map(map), inputTokens: texts.length, costUsd: 0 }; } } };
};

async function seed(sql: postgres.Sql, run: Run) {
  const page = sections([["Origins", `Ana Ruiz founded Andes Payments in 2011. ${run.runId}`], ["Regulation", "The central bank licensed the wallet in 2015."],
    ["Pricing", "Merchant discount rates fell to 1.9 percent."], ["Funding", "A Series B round raised 80 million dollars."]]);
  const [stored] = await storeDiscoveredSources(sql, corpusContext(run) as any, [source("Company page", page, "text/plain", "company_investor_relations")]);
  const rows = await sql`SELECT dc.id, dc.section_title FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id
    WHERE dc.source_document_id = ${stored.sourceId} AND dp.parser_name = 'research-memory'`;
  return { stored, chunk: (t: string) => String(rows.find(r => r.section_title === t)!.id) };
}

const claim = (text: string, sourceId: string, chunkId: string) => ({ claim_text: text, claim_type: "history", claim_category: "fact", confidence: 0.8, source_id: sourceId, document_chunk_id: chunkId });
const idOf = async (sql: postgres.Sql, runId: string, text: string) => String((await sql`SELECT id FROM evidence_claims WHERE research_run_id = ${runId} AND claim_text = ${text}`)[0].id);

test("AC-7: unsafe or broken embedding endpoints fail without revealing the key", async () => {
  const { getEmbeddingProvider } = memory();
  const env = { RESEARCH_EMBEDDING_PROVIDER: "openai-compatible", RESEARCH_EMBEDDING_BASE_URL: "http://embed.example/v1", RESEARCH_MODEL_ALLOWED_HOSTS: "embed.example",
    RESEARCH_EMBEDDING_MODEL: "m", RESEARCH_EMBEDDING_API_KEY: "very-secret-key" };
  assert.throws(() => getEmbeddingProvider(env), (e: Error) => /RESEARCH_EMBEDDING_BASE_URL/.test(e.message) && !e.message.includes("very-secret-key"));
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream failure for very-secret-key", { status: 500 })) as typeof fetch;
  try {
    const live = getEmbeddingProvider({ ...env, RESEARCH_EMBEDDING_BASE_URL: "https://embed.example/v1" });
    await assert.rejects(() => live.embed(["text"]), (e: Error) => !e.message.includes("very-secret-key"));
  } finally { globalThis.fetch = original; }
  const mock = getEmbeddingProvider({ RESEARCH_EMBEDDING_PROVIDER: "mock" });
  const { vectors } = await mock.embed(["alpha beta", "gamma"]);
  assert.ok(vectors.every((v: number[]) => v.length === mock.dimensions));
});

test("AC-8: an exhausted budget stops embedding calls but keeps keyword indexing; models are stored separately", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const broke = await newRun(sql, { budget: 0 }), funded = await newRun(sql);
  try {
    const { ensureDocumentIndexed } = memory();
    const poor = await seed(sql, broke);
    const blocked = provider("model-a", () => [1, 0]);
    const result = await ensureDocumentIndexed(sql, { sourceId: poor.stored.sourceId, runId: broke.runId, embeddings: blocked.embeddings });
    assert.equal(blocked.calls.length, 0, "no provider call without budget");
    assert.ok(result.warnings.length > 0);
    const rich = await seed(sql, funded);
    const a = provider("model-a", () => [1, 0]), b = provider("model-b", () => [0, 1]);
    await ensureDocumentIndexed(sql, { sourceId: rich.stored.sourceId, runId: funded.runId, embeddings: a.embeddings });
    await ensureDocumentIndexed(sql, { sourceId: rich.stored.sourceId, runId: funded.runId, embeddings: b.embeddings });
    const counts = await sql`SELECT embedding_model, COUNT(*)::int AS n FROM document_embeddings de JOIN document_chunks dc ON dc.id = de.document_chunk_id
      WHERE dc.source_document_id = ${rich.stored.sourceId} GROUP BY 1 ORDER BY 1`;
    assert.deepEqual(counts.map(c => c.embedding_model), ["model-a", "model-b"]);
    assert.equal(counts[0].n, counts[1].n);
  } finally { await removeRuns(sql, [broke, funded]); await sql.end(); }
});

test("AC-9: without passage embeddings for the model, ranking stays keyword", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    await seed(sql, run);
    const { retrievePassages } = memory();
    const result = await retrievePassages(sql, { runId: run.runId, need: { key: "pricing", query: "merchant discount rates" }, embeddings: provider("unused-model", () => [1, 0]).embeddings });
    assert.equal(result.ranking, "keyword");
    assert.deepEqual(result.passages[0].section_path, ["Pricing"]);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-10: a superseding version gets its own links and the earlier version keeps its links", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const { stored, chunk } = await seed(sql, run);
    const t1 = "Ana Ruiz founded Andes Payments in 2011.", t2 = "The central bank licensed the wallet in 2015.";
    await persistEvidence(sql, corpusContext(run) as any, [stored], { evidence_claims: [claim(t1, stored.sourceId, chunk("Origins")), claim(t2, stored.sourceId, chunk("Regulation"))] });
    const [c1, c2] = [await idOf(sql, run.runId, t1), await idOf(sql, run.runId, t2)];
    const v1 = await saveReportArtifact(sql, run, "memory_verify", "x", { a: { b: [{ c: { claim_ids: [c1] } }] } });
    const v2 = await saveReportArtifact(sql, run, "memory_verify", "x", { a: { b: [{ c: { claim_ids: [c2] } }] } });
    assert.notEqual(v1.id, v2.id);
    const linked = async (id: string) => (await sql`SELECT evidence_claim_id FROM research_artifact_claim_links WHERE artifact_id = ${id}`).map(r => String(r.evidence_claim_id));
    assert.deepEqual(await linked(v1.id), [c1]);
    assert.deepEqual(await linked(v2.id), [c2]);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-11: out-of-range confidence and malformed claim lists are skipped", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const { stored, chunk } = await seed(sql, run);
    const a = "Merchant discount rates fell to 1.9 percent.", b = "A Series B round raised 80 million dollars.";
    await persistEvidence(sql, corpusContext(run) as any, [stored], {
      evidence_claims: [claim(a, stored.sourceId, chunk("Pricing")), claim(b, stored.sourceId, chunk("Funding"))],
      contradictions: [{ claim_texts: [a, b], description: "Too confident", confidence: 1.5 }, { claim_texts: a, description: "Not a list", confidence: 0.5 },
        { claim_texts: [a, b], description: "Negative", confidence: -0.1 }],
    });
    const edges = await sql`SELECT cr.id FROM claim_relationships cr JOIN evidence_claims ec ON ec.id = cr.from_claim_id WHERE ec.research_run_id = ${run.runId}`;
    assert.equal(edges.length, 0);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-12: the graph is followed one hop only, and graph links break keyword ties", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const { stored, chunk } = await seed(sql, run);
    const t = { o: "Ana Ruiz founded Andes Payments in 2011.", r: "The central bank licensed the wallet in 2015.", p: "Merchant discount rates fell to 1.9 percent." };
    await persistEvidence(sql, corpusContext(run) as any, [stored], {
      evidence_claims: [claim(t.o, stored.sourceId, chunk("Origins")), claim(t.r, stored.sourceId, chunk("Regulation")), claim(t.p, stored.sourceId, chunk("Pricing"))],
      contradictions: [{ claim_texts: [t.o, t.r], description: "First hop", confidence: 0.8 }, { claim_texts: [t.r, t.p], description: "Second hop", confidence: 0.8 }],
    });
    const origin = await idOf(sql, run.runId, t.o);
    const { retrievePassages } = memory();
    const hop = await retrievePassages(sql, { runId: run.runId, need: { key: "hop", query: "unrelated lighthouse keeper", seedClaimIds: [origin] } });
    assert.deepEqual(hop.passages.map((p: any) => p.section_path[0]).sort(), ["Origins", "Regulation"]);
    const same = "Quarterly growth was strong across every merchant cohort this year.";
    const [twins] = await storeDiscoveredSources(sql, corpusContext(run) as any, [source("Twin notes", sections([["Alpha", same], ["Beta", same]]), "text/plain", "industry_primary")]);
    const twinRows = await sql`SELECT dc.id, dc.section_title FROM document_chunks dc JOIN document_parses dp ON dp.id = dc.document_parse_id
      WHERE dc.source_document_id = ${twins.sourceId} AND dp.parser_name = 'research-memory'`;
    const beta = String(twinRows.find(r => r.section_title === "Beta")!.id);
    const betaClaim = "Beta cohort growth claim used to seed the graph.";
    await persistEvidence(sql, corpusContext(run) as any, [twins], { evidence_claims: [claim(betaClaim, twins.sourceId, beta)] });
    const tie = await retrievePassages(sql, { runId: run.runId, need: { key: "tie", query: "quarterly growth merchant cohort", sourceRoles: ["industry_primary"],
      seedClaimIds: [await idOf(sql, run.runId, betaClaim)] } });
    assert.deepEqual(tie.passages.slice(0, 2).map((p: any) => p.section_path[0]), ["Beta", "Alpha"], "the graph-linked twin comes first");
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});
