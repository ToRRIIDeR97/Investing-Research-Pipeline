// Storing a source again must not download, rewrite, re-parse or hold its body: SEC filings (M4), StoredSource (M6),
// research-memory indexing and content-hash files (M7).
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchSecFilingPayloads, storeDiscoveredSources, storedSecFiling } from "../src/lib/research/sources/corpus";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

async function fixture(sql: postgres.Sql) {
  const assetId = randomUUID(), runId = randomUUID();
  const ctx = { runId, runType: "deep_dive", assetId, assetName: "Storage Fixture Co", assetSlug: `storage-${assetId.slice(0, 8)}`, symbol: "STOR",
    profileId: "", profileKey: "", requiredModules: [], requiredLenses: [], marketDataCutoffAt: null, pipelineVersion: 3 };
  await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency) VALUES (${assetId}, ${ctx.assetName}, ${ctx.assetSlug}, 'equity', 'active', 'USD')`;
  await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version)
    VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3)`;
  const files: string[] = [];
  const cleanup = async () => {
    const docs = await sql`SELECT id, storage_path FROM source_documents WHERE asset_id = ${assetId}`;
    const ids = docs.map(doc => String(doc.id));
    const parses = ids.length ? await sql`SELECT output_storage_path FROM document_parses WHERE source_document_id = ANY(${ids}::uuid[])` : [];
    for (const path of [...docs.map(doc => doc.storage_path), ...parses.map(parse => parse.output_storage_path), ...files]) {
      if (path) rmSync(join(process.cwd(), String(path)), { force: true });
    }
    if (ids.length) {
      await sql`DELETE FROM research_run_sources WHERE source_document_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM document_chunks WHERE source_document_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM document_parses WHERE source_document_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM source_documents WHERE id = ANY(${ids}::uuid[])`;
    }
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
  };
  return { ctx, files, cleanup };
}

const payload = (content: string, url: string, mimeType = "text/html") => ({
  sourceType: "sec_filing_10-k", title: "Storage Fixture Co 10-K", publisher: "SEC EDGAR", url, content, mimeType,
  qualityScore: "0.98", publishedAt: "2026-02-01", periodEnd: "2025-12-31", metadata: { system_generated: true, source: "sec_edgar_filing" }, chunkTitle: "10-K",
});

test("a stored source is not rewritten, re-parsed or returned with its body when stored again", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql);
  try {
    const content = `<html><body><h1>Annual report</h1><p>Revenue grew ${randomUUID()}.</p></body></html>`;
    const [first] = await storeDiscoveredSources(sql, f.ctx as any, [payload(content, `https://example.test/${randomUUID()}.htm`)] as any);
    assert.equal("content" in first, false, "StoredSource must not keep the document body alive");
    const [doc] = await sql`SELECT storage_path FROM source_documents WHERE id = ${first.sourceId}`;
    const parseOf = async () => (await sql`SELECT id, output_storage_path, completed_at FROM document_parses
      WHERE source_document_id = ${first.sourceId} AND parser_name = 'research-memory'`)[0];
    const parse = await parseOf();
    assert.equal(parse.output_storage_path, null, "no normalized-text copy is written: nothing reads it (M5)");
    const sourceFile = join(process.cwd(), String(doc.storage_path));
    const written = statSync(sourceFile).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 20));
    const [again] = await storeDiscoveredSources(sql, f.ctx as any, [payload(content, `https://example.test/${randomUUID()}.htm`)] as any);
    assert.equal(again.sourceId, first.sourceId);
    assert.equal(statSync(sourceFile).mtimeMs, written, "the content-hash file is not rewritten");
    const reparsed = await parseOf();
    assert.equal(reparsed.id, parse.id);
    assert.equal(new Date(reparsed.completed_at).getTime(), new Date(parse.completed_at).getTime(), "an indexed document is not parsed again");
  } finally { await f.cleanup(); await sql.end(); }
});

test("an SEC Archives filing stored by an earlier run is reused instead of downloaded and stored again", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql);
  const env = { provider: process.env.RESEARCH_ACCEPTANCE_PROVIDER, testMode: process.env.RESEARCH_TEST_MODE };
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  try {
    const accession = `0000${Math.floor(Math.random() * 1e6)}-26-000001`, document = `stor-${randomUUID().slice(0, 8)}x10k.htm`;
    const url = `https://www.sec.gov/Archives/edgar/data/1234567/${accession.replace(/-/g, "")}/${document}`;
    const body = (script: string) => `<html><body><p>Filing ${url}</p><script type="text/javascript" src="/${script}"></script></body></html>`;
    await storeDiscoveredSources(sql, f.ctx as any, [payload(body("first-run-script"), url)] as any);
    delete process.env.RESEARCH_TEST_MODE;
    process.env.RESEARCH_ACCEPTANCE_PROVIDER = "direct-openai-compatible";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(body(`random-${randomUUID()}`), { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const payloads = await fetchSecFilingPayloads(sql, f.ctx as any, {
      cik: "0001234567", recentFilings: [{ accessionNumber: accession, primaryDocument: document, form: "10-K", reportDate: "2025-12-31", filingDate: "2026-02-01" }],
    });
    assert.deepEqual(fetched, [], "an immutable Archives document is not downloaded again");
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].content, body("first-run-script"), "the stored bytes are reused unchanged");
    await storeDiscoveredSources(sql, f.ctx as any, payloads);
    const copies = await sql`SELECT id FROM source_documents WHERE url = ${url}`;
    assert.equal(copies.length, 1, "the filing is stored once");
  } finally {
    globalThis.fetch = realFetch;
    if (env.provider === undefined) delete process.env.RESEARCH_ACCEPTANCE_PROVIDER; else process.env.RESEARCH_ACCEPTANCE_PROVIDER = env.provider;
    if (env.testMode !== undefined) process.env.RESEARCH_TEST_MODE = env.testMode;
    await f.cleanup(); await sql.end();
  }
});

test("only intact SEC filings the fetcher stored are reused; uploads and truncated files are not", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const f = await fixture(sql);
  try {
    const url = `https://www.sec.gov/Archives/edgar/data/1234567/${randomUUID().replace(/-/g, "")}/stor-10k.htm`;
    const row = async (content: string, at: string, metadata: Record<string, unknown>, fileContent = content) => {
      const hash = createHash("sha256").update(content).digest("hex");
      const path = `storage/sources/${hash}.html`;
      mkdirSync(join(process.cwd(), "storage", "sources"), { recursive: true });
      writeFileSync(join(process.cwd(), path), fileContent);
      f.files.push(path);
      await sql`INSERT INTO source_documents (asset_id, research_run_id, source_type, title, url, file_hash, mime_type, storage_path, metadata_json, created_at)
        VALUES (${f.ctx.assetId}, ${f.ctx.runId}, 'sec_filing_10-k', 't', ${url}, ${hash}, 'text/html', ${path}, ${sql.json(metadata as any)}, ${at})`;
    };
    // What the ingest route writes for an upload with a client-chosen source_type, url and MIME type: metadata_json is {}.
    await row("<html><body>Revenue tripled. Buy.</body></html>", "2026-01-01", {});
    assert.equal(await storedSecFiling(sql, url), null, "an upload labelled as an SEC filing is not reused");
    await row(`<html>truncated ${randomUUID()} filing</html>`, "2026-01-02", { source: "sec_edgar_filing" }, "<html>trunc");
    assert.equal(await storedSecFiling(sql, url), null, "a file that no longer matches its hash is not reused");
    await row("<html>intact filing</html>", "2026-01-03", { system_generated: true, source: "sec_edgar_filing" });
    assert.equal(await storedSecFiling(sql, url), "<html>intact filing</html>");
  } finally { await f.cleanup(); await sql.end(); }
});
