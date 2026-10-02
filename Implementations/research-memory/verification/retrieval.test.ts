import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { storeDiscoveredSources } from "../../../src/lib/research/sources/corpus";
import { corpusContext, loadEnv, memory, newRun, removeRuns, sections, skipDb as skip, source } from "./fixtures";

loadEnv();
delete process.env.RESEARCH_EMBEDDING_PROVIDER;

const founderPage = (nonce: string) => sections([["Our Founders", `Ana Ruiz founded Andes Payments in 2011 after running a bank branch. ${nonce}`], ["Products", "Card acquiring and wallets."]]);

test("AC-5: another run's matching documents never leak into retrieval", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const mine = await newRun(sql), theirs = await newRun(sql);
  try {
    await storeDiscoveredSources(sql, corpusContext(theirs) as any, [source("Their founder page", founderPage(theirs.runId), "text/plain", "founder_and_company_history")]);
    await storeDiscoveredSources(sql, corpusContext(mine) as any, [source("My results", sections([["Results", `Volumes grew. ${mine.runId}`]]), "text/plain", "earnings_release")]);
    const { retrievePassages, FOUNDER_ORIGIN_NEED } = memory();
    const result = await retrievePassages(sql, { runId: mine.runId, need: FOUNDER_ORIGIN_NEED });
    assert.deepEqual(result.passages, []);
    assert.equal(result.gaps[0].reason, "no_documents_for_role");
  } finally { await removeRuns(sql, [mine, theirs]); await sql.end(); }
});

test("AC-5: a document shared by two runs is retrievable from both, and sourceIds narrows the scope", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const first = await newRun(sql), second = await newRun(sql);
  try {
    const content = founderPage(randomUUID());
    const [a] = await storeDiscoveredSources(sql, corpusContext(first) as any, [source("Founder page", content, "text/plain", "founder_and_company_history")]);
    const [b] = await storeDiscoveredSources(sql, corpusContext(second) as any, [source("Founder page again", content, "text/plain", "founder_and_company_history")]);
    assert.equal(a.sourceId, b.sourceId, "the same content is one document");
    const { retrievePassages, FOUNDER_ORIGIN_NEED } = memory();
    for (const run of [first, second]) {
      const result = await retrievePassages(sql, { runId: run.runId, need: FOUNDER_ORIGIN_NEED });
      assert.ok(result.passages.some((p: any) => p.text.includes("Ana Ruiz")));
    }
    const [other] = await storeDiscoveredSources(sql, corpusContext(first) as any, [source("Second founder page", founderPage(randomUUID()), "text/plain", "founder_and_company_history")]);
    const narrowed = await retrievePassages(sql, { runId: first.runId, need: { ...FOUNDER_ORIGIN_NEED, sourceIds: [other.sourceId] } });
    assert.ok(narrowed.passages.length > 0);
    assert.ok(narrowed.passages.every((p: any) => p.source_id === other.sourceId));
  } finally { await removeRuns(sql, [first, second]); await sql.end(); }
});

test("AC-5: a section-title match outranks a body-only match, and maxPassages defaults to 8", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const many = Array.from({ length: 20 }, (_, i) => [`Note ${i + 1}`, `Merchant acquiring volume item ${i + 1}.`] as [string, string]);
    await storeDiscoveredSources(sql, corpusContext(run) as any, [
      source("Press", sections([["Press Coverage", `Articles often retell our founding story. ${run.runId}`]]), "text/plain", "industry_primary"),
      source("History", sections([["Founding Story", "Two engineers wrote the first plan in a garage."]]), "text/plain", "industry_primary"),
      source("Notes", sections(many), "text/plain", "industry_primary"),
    ]);
    const { retrievePassages } = memory();
    const story = await retrievePassages(sql, { runId: run.runId, need: { key: "story", query: "founding story", sourceRoles: ["industry_primary"] } });
    assert.deepEqual(story.passages[0].section_path, ["Founding Story"]);
    const volume = await retrievePassages(sql, { runId: run.runId, need: { key: "volume", query: "merchant acquiring volume", sourceRoles: ["industry_primary"] } });
    assert.equal(volume.passages.length, 8);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-4: concurrent first use indexes a legacy document once, and retrieval indexes it on demand", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
  const run = await newRun(sql);
  try {
    await mkdir("storage/sources", { recursive: true });
    const path = `storage/sources/memory-verify-${run.runId}.txt`;
    await writeFile(path, founderPage(run.runId), "utf8");
    const [legacy] = await sql`INSERT INTO source_documents (asset_id, research_run_id, source_type, title, url, file_hash, mime_type, storage_path, metadata_json)
      VALUES (${run.assetId}, ${run.runId}, 'web_founder_and_company_history', 'Legacy founder page', 'https://verify.example/legacy', ${randomUUID()}, 'text/plain', ${path},
        '{"source_role":"founder_and_company_history"}'::jsonb) RETURNING id`;
    const { ensureDocumentIndexed, retrievePassages, FOUNDER_ORIGIN_NEED } = memory();
    await Promise.all([1, 2, 3].map(() => ensureDocumentIndexed(sql, { sourceId: String(legacy.id) })));
    const parses = await sql`SELECT id FROM document_parses WHERE source_document_id = ${legacy.id} AND parser_name = 'research-memory'`;
    assert.equal(parses.length, 1);
    const [{ dupes }] = await sql`SELECT COUNT(*)::int AS dupes FROM (SELECT chunk_index FROM document_chunks WHERE document_parse_id = ${parses[0].id}
      GROUP BY chunk_index HAVING COUNT(*) > 1) d`;
    assert.equal(dupes, 0);

    const [fresh] = await sql`INSERT INTO source_documents (asset_id, research_run_id, source_type, title, url, file_hash, mime_type, storage_path, metadata_json)
      VALUES (${run.assetId}, ${run.runId}, 'web_founder_and_company_history', 'Unindexed founder page', 'https://verify.example/fresh', ${randomUUID()}, 'text/plain', ${path},
        '{"source_role":"founder_and_company_history"}'::jsonb) RETURNING id`;
    const result = await retrievePassages(sql, { runId: run.runId, need: { ...FOUNDER_ORIGIN_NEED, sourceIds: [String(fresh.id)] } });
    assert.ok(result.passages.some((p: any) => p.text.includes("Ana Ruiz")), "retrieval indexes an unindexed document on demand");
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});

test("AC-4: SEC filing raw files are stored byte for byte", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const run = await newRun(sql);
  try {
    const html = `<html><body><ix:header><ix:hidden>dei:Doc ${run.runId}</ix:hidden></ix:header><p><b>PART I</b></p><p>Item 1. Business &amp; overview.</p></body></html>`;
    const [stored] = await storeDiscoveredSources(sql, corpusContext(run) as any, [{ ...source("10-K", html, "text/html", "regulatory_filing"), sourceType: "sec_filing_10-k" }]);
    const [doc] = await sql`SELECT storage_path FROM source_documents WHERE id = ${stored.sourceId}`;
    assert.equal(await readFile(String(doc.storage_path), "utf8"), html);
  } finally { await removeRuns(sql, [run]); await sql.end(); }
});
