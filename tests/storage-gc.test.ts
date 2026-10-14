// Storage cleanup (audit M10 and the RMEM3 duplicates): the plan only reads; apply repoints SEC copies that differ
// only by SEC's bot script and deletes entries no database references. Runs against a throwaway storage folder.
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStorageGc, normalizedSecHtml, planStorageGc } from "../src/lib/maintenance/storage-gc";

const skip = process.env.RUN_DB_INTEGRATION !== "1";
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

test("the SEC bot script is the only difference normalization removes", () => {
  const body = (tail: string) => `<HTML><BODY><p>Revenue</p>\n${tail}</BODY>\n</HTML>\n</TEXT>`;
  assert.equal(normalizedSecHtml(body('<script type="text/javascript"  src="/KSRe0/abc"></script>')), body(""));
  assert.equal(normalizedSecHtml('<html><body>x<script type="text/javascript" src="/r1"></script></body></html>'), "<html><body>x</body></html>");
  assert.equal(normalizedSecHtml("<html><body>x<p>more</p></body></html>"), "<html><body>x<p>more</p></body></html>");
});

test("cleanup plans without changing anything, then repoints duplicates and deletes only unreferenced entries", { skip }, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const root = mkdtempSync(join(tmpdir(), "storage-gc-"));
  const storageRoot = join(root, "storage");
  for (const dir of ["sources", "parses", "exports", "backtests"]) mkdirSync(join(storageRoot, dir), { recursive: true });
  const assetId = randomUUID(), runId = randomUUID(), orphanRun = randomUUID();
  const url = `https://www.sec.gov/Archives/edgar/data/1234567/${randomUUID().replace(/-/g, "")}/gc-10k.htm`;
  const ids: string[] = [];
  try {
    await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind, status, base_currency) VALUES (${assetId}, 'GC Fixture', ${`gc-${assetId.slice(0, 8)}`}, 'equity', 'active', 'USD')`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, source_cutoff_at, pipeline_version) VALUES (${runId}, ${assetId}, 'deep_dive', 'running', '2026-10-01', 3)`;
    const file = (rel: string, content: string) => { writeFileSync(join(root, rel), content); return rel; };
    const doc = async (content: string, at: string) => {
      const hash = createHash("sha256").update(content).digest("hex");
      const path = file(`storage/sources/${hash}.html`, content);
      const [row] = await sql`INSERT INTO source_documents (asset_id, research_run_id, source_type, title, url, file_hash, mime_type, storage_path, metadata_json, created_at)
        VALUES (${assetId}, ${runId}, 'sec_filing_10-k', 't', ${url}, ${hash}, 'text/html', ${path}, ${sql.json({ source: "sec_edgar_filing" })}, ${at}) RETURNING id`;
      ids.push(String(row.id));
      await sql`INSERT INTO document_parses (source_document_id, parser_name, parser_version, status, warnings_json, output_storage_path)
        VALUES (${row.id}, 'system-source-payload', '2', 'completed', '[]', ${path})`;
      return { id: String(row.id), path };
    };
    const filing = `<html><body><p>Filing ${url}</p>`;
    const first = await doc(`${filing}</body></html>`, "2026-01-01");
    const copy = await doc(`${filing}<script type="text/javascript" src="/${randomUUID()}"></script></body></html>`, "2026-01-02");
    const amended = await doc(`${filing}<p>restated</p></body></html>`, "2026-01-03");
    const orphan = file("storage/sources/orphan.json", "{}");
    file("storage/parses/orphan.txt", "text");
    mkdirSync(join(storageRoot, "backtests", runId)); file(`storage/backtests/${runId}/result.json`, "{}");
    mkdirSync(join(storageRoot, "backtests", orphanRun)); file(`storage/backtests/${orphanRun}/result.json`, "{}");
    const fresh = file("storage/sources/just-written.json", "{}");
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    for (const rel of [first.path, copy.path, amended.path, orphan,"storage/parses/orphan.txt", `storage/backtests/${orphanRun}/result.json`, `storage/backtests/${orphanRun}`, `storage/backtests/${runId}/result.json`]) {
      utimesSync(join(root, rel), old, old);
    }

    const db = [{ name: "test", sql }];
    const plan = await planStorageGc(db, { storageRoot, minAgeMs: 86_400_000 });
    assert.deepEqual(plan.repoints.map(r => [r.sourceId, r.to]), [[copy.id, first.path]]);
    assert.deepEqual(plan.skippedDuplicates.map(s => s.sourceId), [amended.id], "a copy with other changes is kept");
    const planned = plan.candidates.map(c => c.path.slice(root.length + 1)).sort();
    assert.deepEqual(planned, [copy.path, "storage/backtests/" + orphanRun, "storage/parses/orphan.txt", orphan].sort());
    assert.ok(plan.tooNew >= 1, "an unreferenced file newer than the cutoff is kept");
    assert.ok(existsSync(join(root, copy.path)), "planning changes nothing");
    const [unchanged] = await sql`SELECT storage_path FROM source_documents WHERE id = ${copy.id}`;
    assert.equal(unchanged.storage_path, copy.path);

    const result = await applyStorageGc(db, plan);
    assert.equal(result.repointed, 1);
    assert.equal(result.deleted, 4);
    const [moved] = await sql`SELECT storage_path, metadata_json FROM source_documents WHERE id = ${copy.id}`;
    assert.equal(moved.storage_path, first.path);
    assert.equal(moved.metadata_json.storage_deduplicated.original_storage_path, copy.path);
    const [parse] = await sql`SELECT output_storage_path FROM document_parses WHERE source_document_id = ${copy.id}`;
    assert.equal(parse.output_storage_path, first.path);
    for (const kept of [first.path, amended.path, fresh, `storage/backtests/${runId}/result.json`]) assert.ok(existsSync(join(root, kept)), `${kept} is kept`);
    for (const gone of [copy.path, orphan, "storage/parses/orphan.txt", `storage/backtests/${orphanRun}`]) assert.equal(existsSync(join(root, gone)), false, `${gone} is deleted`);
  } finally {
    if (ids.length) {
      await sql`DELETE FROM document_parses WHERE source_document_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM source_documents WHERE id = ANY(${ids}::uuid[])`;
    }
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    rmSync(root, { recursive: true, force: true });
    await sql.end();
  }
});
