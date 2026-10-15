// Git-backed research store: moves research between machines that each run their own local Postgres.
// Export writes every synced table as sorted JSONL plus the storage/ files rows name; import merges a store back
// into the local database. The local database is the merge point, git only carries files. See docs/operations.md.
import postgres from "postgres";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

type Sql = postgres.Sql;

export const STORE_FORMAT = 1;
/** Machine-local state: the queue and heartbeats would make an imported run start, or look alive, elsewhere. */
export const EXCLUDED_TABLES = new Set(["research_run_jobs", "research_worker_heartbeats"]);
/** GitHub rejects files over 100 MB. */
const MAX_FILE_BYTES = 95 * 1024 * 1024;
const BATCH_ROWS = 500;
const STORAGE_PATH = /"(storage\/[^"\\]+)"/g;

/** Per table, the hash of each row as of this machine's last export. Lets import tell who changed a row. */
export type StoreBase = Record<string, Record<string, string>>;

export interface TableInfo { name: string; columns: string[]; types: string[]; hasUpdatedAt: boolean; uniqueKeys: string[][]; selfReferencing: boolean }

export type Decision = "insert" | "update" | "keep" | "same" | "remap";
export interface Conflict { table: string; id: string; kept: "local" | "store" }
export interface ImportResult { inserted: number; updated: number; remapped: number; conflicts: Conflict[]; filesCopied: number; fileConflicts: string[] }
export interface ExportResult { tables: number; rows: number; files: number; skippedFiles: string[]; base: StoreBase }

export const rowHash = (line: string) => createHash("sha1").update(line).digest("hex").slice(0, 16);
const shardOf = (id: string) => id.slice(0, 1).toLowerCase();

/**
 * Three-way decision for one store row. `base` is the row's hash when this machine last exported, so a side whose
 * hash still equals it did not change the row. When both sides changed it, the newer updated_at wins; a table
 * without updated_at keeps the local row.
 */
export function decideRow(input: { line: string; local?: string; base?: string; storeUpdatedAt?: string | null; localUpdatedAt?: string | null }): { decision: Decision; conflict?: "local" | "store" } {
  const incoming = rowHash(input.line);
  if (input.local === undefined) {
    // Deleted here since the last export and unchanged in the store: the deletion stands.
    if (input.base !== undefined && input.base === incoming) return { decision: "keep" };
    return { decision: "insert" };
  }
  if (input.local === incoming) return { decision: "same" };
  if (input.base === incoming) return { decision: "keep" };
  if (input.base === input.local) return { decision: "update" };
  const storeTime = input.storeUpdatedAt ? Date.parse(input.storeUpdatedAt) : NaN;
  const localTime = input.localUpdatedAt ? Date.parse(input.localUpdatedAt) : NaN;
  if (storeTime > localTime) return { decision: "update", conflict: "store" };
  return { decision: "keep", conflict: "local" };
}

/** Tables in foreign-key order (parents first). Self-references are loaded in one statement, so they don't count. */
export function orderTables(tables: string[], edges: Array<{ from: string; to: string }>): string[] {
  const deps = new Map(tables.map(t => [t, new Set<string>()]));
  for (const e of edges) if (e.from !== e.to && deps.has(e.from) && deps.has(e.to)) deps.get(e.from)!.add(e.to);
  const ordered: string[] = [];
  const done = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter(t => !done.has(t) && [...deps.get(t)!].every(d => done.has(d))).sort();
    if (!ready.length) throw new Error(`Foreign-key cycle between ${tables.filter(t => !done.has(t)).join(", ")}`);
    for (const t of ready) { ordered.push(t); done.add(t); }
  }
  return ordered;
}

export async function describeTables(sql: Sql): Promise<TableInfo[]> {
  const tables = (await sql`SELECT c.relname::text AS name FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`).map(r => String(r.name)).filter(t => !EXCLUDED_TABLES.has(t));
  const columns = await sql`SELECT table_name::text AS t, column_name::text AS c, udt_name::text AS type FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`;
  const edges = (await sql`SELECT conrelid::regclass::text AS "from", confrelid::regclass::text AS "to" FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace`).map(r => ({ from: String(r.from), to: String(r.to) }));
  for (const e of edges) {
    if (tables.includes(e.from) && EXCLUDED_TABLES.has(e.to)) throw new Error(`${e.from} references machine-local table ${e.to}`);
  }
  // Partial and expression indexes only bind some rows, so they can't identify a row on their own.
  const uniques = await sql`SELECT c.relname::text AS t, ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o) AS cols
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relnamespace = 'public'::regnamespace AND i.indisunique AND NOT i.indisprimary AND i.indexprs IS NULL AND i.indpred IS NULL`;
  const info = new Map<string, TableInfo>();
  for (const t of tables) {
    const own = columns.filter(r => r.t === t);
    const cols = own.map(r => String(r.c));
    if (!cols.includes("id")) throw new Error(`${t} has no id column; the store keys rows by id`);
    info.set(t, { name: t, columns: cols, types: own.map(r => `${r.c} ${r.type}`), hasUpdatedAt: cols.includes("updated_at"),
      uniqueKeys: uniques.filter(u => u.t === t).map(u => u.cols as string[]),
      selfReferencing: edges.some(e => e.from === t && e.to === t) });
  }
  return orderTables(tables, edges).map(t => info.get(t)!);
}

/** Column names and types per table, in any order. Import needs both sides to match: missing columns would load as NULL. */
const schemaOf = (tables: TableInfo[]) => Object.fromEntries(tables.map(t => [t.name, [...t.types].sort()]));

/** Healthy research workers on this database in the last 30 s. */
export async function liveWorkerIds(sql: Sql): Promise<string[]> {
  const rows = await sql`SELECT worker_id FROM research_worker_heartbeats
    WHERE status = 'healthy' AND last_seen_at > NOW() - INTERVAL '30 seconds'`.catch(() => []);
  return rows.map(r => String(r.worker_id));
}

async function localRows(sql: Sql, table: string): Promise<Array<{ id: string; line: string }>> {
  return (await sql`SELECT id::text AS id, to_jsonb(t)::text AS line FROM ${sql(table)} t ORDER BY id`)
    .map(r => ({ id: String(r.id), line: String(r.line) }));
}

async function readStoreTable(storeDir: string, table: string): Promise<string[]> {
  const dir = join(storeDir, "tables", table);
  let names: string[];
  try { names = (await readdir(dir)).filter(n => n.endsWith(".jsonl")).sort(); } catch { return []; }
  const lines: string[] = [];
  for (const name of names) for (const line of (await readFile(join(dir, name), "utf8")).split(/\r?\n/)) if (line) lines.push(line);
  return lines;
}

async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const found: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) found.push(...await listFiles(path)); else found.push(path);
  }
  return found;
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
    return ba.equals(bb);
  } catch { return false; }
}

const posix = (path: string) => path.split(sep).join("/");

export async function exportStore(sql: Sql, options: { storeDir: string; projectRoot: string }): Promise<ExportResult> {
  const storeDir = resolve(options.storeDir);
  const tables = await describeTables(sql);
  const base: StoreBase = {};
  const referenced = new Set<string>();
  let rows = 0;
  await mkdir(join(storeDir, "tables"), { recursive: true });
  for (const table of tables) {
    const shards = new Map<string, string[]>();
    base[table.name] = {};
    for (const row of await localRows(sql, table.name)) {
      base[table.name][row.id] = rowHash(row.line);
      const shard = shardOf(row.id);
      shards.set(shard, [...(shards.get(shard) || []), row.line]);
      for (const m of row.line.matchAll(STORAGE_PATH)) referenced.add(m[1]);
      rows += 1;
    }
    const dir = join(storeDir, "tables", table.name);
    await rm(dir, { recursive: true, force: true });
    if (shards.size) await mkdir(dir, { recursive: true });
    for (const [shard, lines] of shards) await writeFile(join(dir, `${shard}.jsonl`), lines.join("\n") + "\n");
  }
  // Tables that no longer exist here leave no stale directory behind.
  const names = new Set(tables.map(t => t.name));
  for (const entry of await readdir(join(storeDir, "tables"))) if (!names.has(entry)) await rm(join(storeDir, "tables", entry), { recursive: true, force: true });

  // Mirror the storage/ files rows name. A referenced directory (a backtest run folder) goes in whole.
  const filesDir = join(storeDir, "files");
  const wanted = new Set<string>();
  const skippedFiles: string[] = [];
  for (const ref of referenced) {
    const source = resolve(options.projectRoot, ref);
    if (!source.startsWith(resolve(options.projectRoot, "storage") + sep)) continue;
    let info;
    try { info = await stat(source); } catch { continue; }
    for (const file of info.isDirectory() ? await listFiles(source) : [source]) {
      const rel = posix(relative(options.projectRoot, file));
      if ((await stat(file)).size > MAX_FILE_BYTES) { skippedFiles.push(rel); continue; }
      wanted.add(rel);
      const target = join(filesDir, rel);
      if (await sameFile(file, target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);
    }
  }
  for (const file of await listFiles(filesDir)) if (!wanted.has(posix(relative(filesDir, file)))) await rm(file);

  // Stored bytes must survive checkout unchanged: source files are checked against their file_hash.
  await writeFile(join(storeDir, ".gitattributes"), "* -text\n");
  const manifest = { format: STORE_FORMAT, excludedTables: [...EXCLUDED_TABLES], schema: schemaOf(tables) };
  await writeFile(join(storeDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { tables: tables.length, rows, files: wanted.size, skippedFiles, base };
}

function uniqueValue(row: Record<string, unknown>, cols: string[]): string | null {
  const values = cols.map(c => row[c]);
  return values.some(v => v === null || v === undefined) ? null : JSON.stringify(values);
}

/**
 * Merges the store into the local database in one transaction, so a failure changes nothing. Rows are upserted in
 * foreign-key order. A store row whose unique key (an asset slug, a file hash, a seeded definition) matches a
 * different local row is taken to be that row: its id is rewritten to the local id everywhere it appears.
 */
export async function importStore(sql: Sql, options: { storeDir: string; projectRoot: string; base: StoreBase }): Promise<ImportResult> {
  const storeDir = resolve(options.storeDir);
  const manifest = JSON.parse(await readFile(join(storeDir, "manifest.json"), "utf8"));
  if (manifest.format !== STORE_FORMAT) throw new Error(`Store format ${manifest.format} is not supported (expected ${STORE_FORMAT})`);
  const tables = await describeTables(sql);
  const local = schemaOf(tables);
  const differing = [...new Set([...Object.keys(local), ...Object.keys(manifest.schema)])]
    .filter(t => JSON.stringify(local[t]) !== JSON.stringify(manifest.schema[t]));
  if (differing.length) {
    throw new Error(`Schema mismatch in ${differing.join(", ")}. Bring both machines to the same code and run npm run db:migrate first.`);
  }
  const result: ImportResult = { inserted: 0, updated: 0, remapped: 0, conflicts: [], filesCopied: 0, fileConflicts: [] };
  const remap = new Map<string, string>();
  const rewrite = (line: string) => {
    for (const [from, to] of remap) if (line.includes(from)) line = line.split(from).join(to);
    return line;
  };

  await sql.begin(async tx => {
    for (const table of tables) {
      const lines = (await readStoreTable(storeDir, table.name)).map(rewrite);
      if (!lines.length) continue;
      const here = await localRows(tx as unknown as Sql, table.name);
      const localById = new Map(here.map(r => [r.id, r.line]));
      const parsedLocal = table.uniqueKeys.length || table.hasUpdatedAt ? new Map(here.map(r => [r.id, JSON.parse(r.line)])) : new Map();
      const byUnique = table.uniqueKeys.map(cols => {
        const index = new Map<string, string>();
        for (const [id, row] of parsedLocal) { const key = uniqueValue(row, cols); if (key) index.set(key, id); }
        return { cols, index };
      });
      const base = options.base[table.name] || {};
      const accepted: string[] = [];
      for (const line of lines) {
        const row = JSON.parse(line);
        const id = String(row.id);
        const localLine = localById.get(id);
        if (localLine === undefined) {
          const match = byUnique.map(u => { const key = uniqueValue(row, u.cols); return key ? u.index.get(key) : undefined; }).find(Boolean);
          if (match) { remap.set(id, match); result.remapped += 1; continue; }
        }
        const { decision, conflict } = decideRow({ line, local: localLine === undefined ? undefined : rowHash(localLine), base: base[id],
          storeUpdatedAt: row.updated_at ?? null, localUpdatedAt: parsedLocal.get(id)?.updated_at ?? null });
        if (conflict) result.conflicts.push({ table: table.name, id, kept: conflict });
        if (decision === "insert") result.inserted += 1;
        if (decision === "update") result.updated += 1;
        if (decision === "insert" || decision === "update") accepted.push(line);
      }
      // A self-referencing table goes in one statement: its foreign keys are checked at the end of the statement.
      const size = table.selfReferencing ? accepted.length : BATCH_ROWS;
      const assignments = table.columns.filter(c => c !== "id").map(c => `"${c}" = EXCLUDED."${c}"`).join(", ");
      for (let i = 0; i < accepted.length; i += size) {
        const batch = `[${accepted.slice(i, i + size).join(",")}]`;
        await tx.unsafe(`INSERT INTO "${table.name}" SELECT * FROM json_populate_recordset(NULL::"${table.name}", $1::text::json)
          ON CONFLICT (id) DO ${assignments ? `UPDATE SET ${assignments}` : "NOTHING"}`, [batch]);
      }
    }
  });

  // Files: copy what this machine lacks. A file that differs is left alone and reported.
  const filesDir = join(storeDir, "files");
  for (const file of await listFiles(filesDir)) {
    const rel = relative(filesDir, file);
    const target = resolve(options.projectRoot, rel);
    try {
      await stat(target);
      if (!await sameFile(file, target)) result.fileConflicts.push(posix(rel));
    } catch {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);
      result.filesCopied += 1;
    }
  }
  return result;
}

export async function readBase(path: string): Promise<StoreBase> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
}

export async function writeBase(path: string, base: StoreBase) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(base));
}
