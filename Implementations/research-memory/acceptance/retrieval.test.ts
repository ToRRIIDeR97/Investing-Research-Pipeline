import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { cleanup, corpusCtx, createRun, earningsText, loadEnv, loadMemory, payload, prospectusHtml, skipDb as skip } from "./fixtures";

loadEnv();

test("AC-4: stored sources are indexed as research-memory passages with section titles and paths", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const [stored] = await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "Final Prospectus", content: prospectusHtml(run.runId), mimeType: "text/html", role: "founder_and_company_history" }),
    ]);
    const [parse] = await sql`SELECT id FROM document_parses WHERE source_document_id = ${stored.sourceId}
      AND parser_name = 'research-memory' AND parser_version = ${loadMemory().MEMORY_PARSER_VERSION} AND status = 'completed'`;
    assert.ok(parse, "a research-memory parse exists");
    const chunks = await sql`SELECT section_title, metadata_json, text FROM document_chunks WHERE document_parse_id = ${parse.id} ORDER BY chunk_index`;
    const history = chunks.find(c => String(c.text).includes("co-founder"));
    assert.equal(history?.section_title, "History of MercadoLibre");
    assert.deepEqual(history?.metadata_json.section_path, ["BUSINESS", "History of MercadoLibre"]);
    const { ensureDocumentIndexed } = loadMemory();
    const again = await ensureDocumentIndexed(sql, { sourceId: stored.sourceId });
    assert.equal(again.status, "current");
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM document_chunks WHERE document_parse_id = ${parse.id}`;
    assert.equal(count, chunks.length);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-4: a document with only an older parse is indexed on first use; a missing file is reported, not thrown", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    const { ensureDocumentIndexed } = loadMemory();
    await mkdir("storage/sources", { recursive: true });
    const path = `storage/sources/memory-legacy-${run.runId}.html`;
    await writeFile(path, prospectusHtml(run.runId), "utf8");
    const [legacy] = await sql`INSERT INTO source_documents (asset_id, research_run_id, source_type, title, url, file_hash, mime_type, storage_path, metadata_json)
      VALUES (${run.assetId}, ${run.runId}, 'web_founder_and_company_history', 'Legacy prospectus', 'https://fixture.example/legacy', ${randomUUID()}, 'text/html', ${path}, '{"source_role":"founder_and_company_history"}'::jsonb) RETURNING id`;
    const [oldParse] = await sql`INSERT INTO document_parses (source_document_id, parser_name, parser_version, status, completed_at)
      VALUES (${legacy.id}, 'system-source-payload', '2', 'completed', NOW()) RETURNING id`;
    await sql`INSERT INTO document_chunks (source_document_id, document_parse_id, chunk_index, section_title, char_start, char_end, text)
      VALUES (${legacy.id}, ${oldParse.id}, 0, 'Legacy prospectus', 0, 9000, 'cover page only')`;
    const result = await ensureDocumentIndexed(sql, { sourceId: String(legacy.id) });
    assert.equal(result.status, "indexed");
    assert.ok(result.passages > 1);

    const [missing] = await sql`INSERT INTO source_documents (asset_id, research_run_id, source_type, title, file_hash, mime_type, storage_path)
      VALUES (${run.assetId}, ${run.runId}, 'web_industry_primary', 'Gone', ${randomUUID()}, 'text/html', 'storage/sources/does-not-exist.html') RETURNING id`;
    const gone = await ensureDocumentIndexed(sql, { sourceId: String(missing.id) });
    assert.equal(gone.status, "unreadable");
    assert.ok(gone.warnings.length > 0);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-5: retrieval is scoped to the run and role, ranks section matches first, and carries provenance", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "Final Prospectus", content: prospectusHtml(run.runId), mimeType: "text/html", role: "founder_and_company_history" }),
      payload({ title: "Q3 results", content: earningsText(run.runId), mimeType: "text/plain", role: "earnings_release" }),
    ]);
    const { retrievePassages, FOUNDER_ORIGIN_NEED } = loadMemory();
    const result = await retrievePassages(sql, { runId: run.runId, need: FOUNDER_ORIGIN_NEED });
    assert.equal(result.ranking, "keyword");
    assert.ok(result.passages.length >= 1);
    const top = result.passages[0];
    assert.deepEqual(top.section_path.slice(-1), ["History of MercadoLibre"]);
    assert.match(top.text, /co-founder/);
    assert.equal(top.source_role, "founder_and_company_history");
    for (const key of ["passage_id", "source_id", "parse_id", "char_start", "char_end"]) assert.ok(top[key] !== undefined && top[key] !== null, key);
    assert.ok(result.passages.every((p: any) => p.source_role === "founder_and_company_history"));
    const again = await retrievePassages(sql, { runId: run.runId, need: FOUNDER_ORIGIN_NEED });
    assert.deepEqual(again.passages.map((p: any) => p.passage_id), result.passages.map((p: any) => p.passage_id));
    const credit = await retrievePassages(sql, { runId: run.runId, need: { key: "credit", query: "non-performing loans credit quality", maxPassages: 1 } });
    assert.equal(credit.passages.length, 1);
    assert.deepEqual(credit.passages[0].section_path, ["Credit Quality"]);
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});

test("AC-5: empty scopes and unmatched queries return coverage gaps", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await createRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusCtx(run) as any, [
      payload({ title: "Q3 results", content: earningsText(run.runId), mimeType: "text/plain", role: "earnings_release" }),
    ]);
    const { retrievePassages, FOUNDER_ORIGIN_NEED } = loadMemory();
    const none = await retrievePassages(sql, { runId: run.runId, need: FOUNDER_ORIGIN_NEED });
    assert.deepEqual(none.passages, []);
    assert.equal(none.gaps[0]?.reason, "no_documents_for_role");
    const unmatched = await retrievePassages(sql, { runId: run.runId, need: { key: "spectrum", query: "satellite spectrum licences", sourceRoles: ["earnings_release"] } });
    assert.deepEqual(unmatched.passages, []);
    assert.equal(unmatched.gaps[0]?.reason, "no_matching_passages");
  } finally { await cleanup(sql, [run.runId], [run.assetId]); await sql.end(); }
});
