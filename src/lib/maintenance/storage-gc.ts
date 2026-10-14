// Storage hygiene (optimisation audit M10 and the RMEM3 cleanup): find files under storage/ that no database
// references, and SEC filing copies that differ from an earlier copy only by SEC's per-request bot script.
// Planning only reads. applyStorageGc changes rows and deletes files; scripts/storage-gc.ts runs it only with --apply.
import postgres from "postgres";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type Sql = postgres.Sql;

export interface GcDatabase { name: string; sql: Sql }

export interface SecRepoint {
  database: string;
  sourceId: string;
  canonicalSourceId: string;
  from: string;
  to: string;
}

export interface GcCandidate { category: "sources" | "parses" | "exports" | "backtests"; path: string; bytes: number }

export interface GcPlan {
  storageRoot: string;
  minAgeMs: number;
  includeParseTexts: boolean;
  repoints: SecRepoint[];
  /** Duplicate rows left alone: their file is missing, or differs from the canonical copy by more than the script. */
  skippedDuplicates: Array<{ database: string; sourceId: string; reason: string }>;
  parseTextRows: Array<{ database: string; rows: number }>;
  candidates: GcCandidate[];
  /** Entries that look unreferenced but are newer than the age cutoff. */
  tooNew: number;
}

// SEC inserts this tag, with a random path, just before </body> (or </BODY>, in .txt-wrapped filings) on every
// Archives response; older downloads have none. EDGAR rejects active content, so filings never carry it themselves.
const SEC_BOT_SCRIPT = /<script type="text\/javascript"\s+src="\/[^"]*"><\/script>(?=<\/body>)/i;

export function normalizedSecHtml(content: string): string {
  return content.replace(SEC_BOT_SCRIPT, "");
}

async function tableExists(sql: Sql, table: string) {
  const [row] = await sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`;
  return Boolean(row?.present);
}

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

/** Newest modification time of a file, or of anything inside a directory. */
async function newestMtime(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  for (const entry of await readdir(path)) newest = Math.max(newest, await newestMtime(join(path, entry)));
  return newest;
}

async function fileHash(path: string): Promise<string | null> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); } catch { return null; }
}

/**
 * Rows the SEC fetcher stored for one Archives URL (the same filter storedSecFiling reuses). The first row whose
 * file still matches its hash is canonical; a later row whose file equals it once the bot script is removed is
 * pointed at the canonical file. Its own row, chunks and citations stay; only the redundant file goes.
 */
async function planSecRepoints(db: GcDatabase, projectRoot: string, plan: GcPlan) {
  const rows = await db.sql`SELECT id, url, storage_path, file_hash FROM source_documents
    WHERE url LIKE 'https://www.sec.gov/Archives/%' AND source_type LIKE 'sec\\_filing\\_%' AND mime_type = 'text/html'
      AND metadata_json->>'source' = 'sec_edgar_filing' AND storage_path LIKE 'storage/sources/%'
      AND url IN (SELECT url FROM source_documents WHERE url LIKE 'https://www.sec.gov/Archives/%' GROUP BY url HAVING COUNT(DISTINCT storage_path) > 1)
    ORDER BY url, created_at, id`;
  const groups = new Map<string, postgres.Row[]>();
  for (const row of rows) groups.set(String(row.url), [...(groups.get(String(row.url)) || []), row]);
  for (const group of groups.values()) {
    let canonical: postgres.Row | undefined;
    for (const row of group) {
      if (await fileHash(resolve(projectRoot, String(row.storage_path))) === row.file_hash) { canonical = row; break; }
    }
    if (!canonical) continue;
    const canonicalText = normalizedSecHtml(await readFile(resolve(projectRoot, String(canonical.storage_path)), "utf8"));
    for (const row of group) {
      if (row === canonical || row.storage_path === canonical.storage_path) continue;
      let text: string;
      try { text = await readFile(resolve(projectRoot, String(row.storage_path)), "utf8"); } catch {
        plan.skippedDuplicates.push({ database: db.name, sourceId: String(row.id), reason: "file missing" });
        continue;
      }
      if (normalizedSecHtml(text) !== canonicalText) {
        plan.skippedDuplicates.push({ database: db.name, sourceId: String(row.id), reason: "differs beyond the bot script" });
        continue;
      }
      plan.repoints.push({ database: db.name, sourceId: String(row.id), canonicalSourceId: String(canonical.id),
        from: String(row.storage_path), to: String(canonical.storage_path) });
    }
  }
}

/** Every storage path any database still refers to, as absolute paths, plus every research run id. */
async function references(dbs: GcDatabase[], projectRoot: string, plan: Pick<GcPlan, "repoints" | "includeParseTexts">) {
  const paths = new Set<string>();
  const runIds = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) paths.add(resolve(projectRoot, value)); };
  for (const db of dbs) {
    // A repointed row's old file, and its system-source-payload parse path (the same file), no longer count.
    const repointed = new Map(plan.repoints.filter(r => r.database === db.name).map(r => [r.sourceId, r.from]));
    for (const row of await db.sql`SELECT id, storage_path FROM source_documents`) {
      if (repointed.get(String(row.id)) !== row.storage_path) add(row.storage_path);
    }
    for (const row of await db.sql`SELECT source_document_id AS id, output_storage_path AS path FROM document_parses WHERE output_storage_path IS NOT NULL`) {
      if (plan.includeParseTexts && String(row.path).startsWith("storage/parses/")) continue;
      if (repointed.get(String(row.id)) !== row.path) add(row.path);
    }
    for (const table of ["exports", "backtest_artifacts", "valuation_artifacts"]) {
      if (await tableExists(db.sql, table)) for (const row of await db.sql`SELECT storage_path AS path FROM ${db.sql(table)}`) add(row.path);
    }
    for (const row of await db.sql`SELECT content_json->>'storagePath' AS path FROM research_artifacts WHERE artifact_type = 'synthetic_report'`) add(row.path);
    for (const row of await db.sql`SELECT id FROM research_runs`) runIds.add(String(row.id));
  }
  // A directory is in use when it holds a referenced path.
  const holders = new Set<string>();
  for (const path of paths) for (let dir = dirname(path); dir !== dirname(dir) && !holders.has(dir); dir = dirname(dir)) holders.add(dir);
  return { paths, holders, runIds };
}

async function candidates(storageRoot: string, minAgeMs: number, refs: Awaited<ReturnType<typeof references>>) {
  const found: GcCandidate[] = [];
  let tooNew = 0;
  const now = Date.now();
  const referenced = (path: string) => refs.paths.has(path) || refs.holders.has(path);
  for (const category of ["sources", "parses", "exports", "backtests"] as const) {
    const dir = join(storageRoot, category);
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      if (category === "backtests" ? refs.runIds.has(name) || referenced(path) : referenced(path)) continue;
      if (now - await newestMtime(path) < minAgeMs) { tooNew += 1; continue; }
      found.push({ category, path, bytes: await sizeOf(path) });
    }
  }
  return { found, tooNew };
}

export async function planStorageGc(dbs: GcDatabase[], options: { storageRoot: string; minAgeMs: number; includeParseTexts?: boolean }): Promise<GcPlan> {
  const storageRoot = resolve(options.storageRoot);
  const projectRoot = dirname(storageRoot);
  const plan: GcPlan = { storageRoot, minAgeMs: options.minAgeMs, includeParseTexts: Boolean(options.includeParseTexts),
    repoints: [], skippedDuplicates: [], parseTextRows: [], candidates: [], tooNew: 0 };
  for (const db of dbs) await planSecRepoints(db, projectRoot, plan);
  if (plan.includeParseTexts) for (const db of dbs) {
    const [row] = await db.sql`SELECT COUNT(*)::int AS n FROM document_parses WHERE output_storage_path LIKE 'storage/parses/%'`;
    plan.parseTextRows.push({ database: db.name, rows: Number(row.n) });
  }
  const { found, tooNew } = await candidates(storageRoot, options.minAgeMs, await references(dbs, projectRoot, plan));
  plan.candidates = found;
  plan.tooNew = tooNew;
  return plan;
}

/**
 * Repoints the planned SEC duplicates, clears parse-text paths when asked, then deletes only the candidates that
 * are still unreferenced after a fresh look at every database.
 */
export async function applyStorageGc(dbs: GcDatabase[], plan: GcPlan) {
  const byName = new Map(dbs.map(db => [db.name, db]));
  let repointed = 0;
  for (const db of dbs) {
    const mine = plan.repoints.filter(r => r.database === db.name);
    if (!mine.length) continue;
    await db.sql.begin(async tx => {
      for (const r of mine) {
        const note = { storage_deduplicated: { original_storage_path: r.from, canonical_source_id: r.canonicalSourceId, at: new Date().toISOString() } };
        const updated = await tx`UPDATE source_documents SET storage_path = ${r.to}, metadata_json = metadata_json || ${tx.json(note)}
          WHERE id = ${r.sourceId} AND storage_path = ${r.from}`;
        repointed += updated.count;
        if (updated.count) await tx`UPDATE document_parses SET output_storage_path = ${r.to}
          WHERE source_document_id = ${r.sourceId} AND output_storage_path = ${r.from}`;
      }
    });
  }
  if (plan.includeParseTexts) for (const entry of plan.parseTextRows) {
    await byName.get(entry.database)!.sql`UPDATE document_parses SET output_storage_path = NULL WHERE output_storage_path LIKE 'storage/parses/%'`;
  }
  const projectRoot = dirname(plan.storageRoot);
  const refs = await references(dbs, projectRoot, { repoints: [], includeParseTexts: false });
  const fresh = await candidates(plan.storageRoot, plan.minAgeMs, refs);
  const stillFree = new Set(fresh.found.map(c => c.path));
  let deleted = 0, bytes = 0;
  for (const candidate of plan.candidates) {
    if (!stillFree.has(candidate.path)) continue;
    await rm(candidate.path, { recursive: true, force: true });
    deleted += 1;
    bytes += candidate.bytes;
  }
  return { repointed, deleted, bytes };
}
