// Git-backed research store: moves research between machines that each run their own local Postgres.
// Export writes every synced table as sorted JSONL plus the storage/ files rows name; import merges a store back
// into the local database. The local database is the merge point, git only carries files. See docs/operations.md.
import postgres from "postgres";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

type Sql = postgres.Sql;

export const STORE_FORMAT = 1;
/** Machine-local state: the queue and heartbeats would make an imported run start, or look alive, elsewhere. */
export const EXCLUDED_TABLES = new Set(["research_run_jobs", "research_worker_heartbeats"]);
/** GitHub rejects files over 100 MB. Applies to mirrored files and table shards. */
export const MAX_FILE_BYTES = 95 * 1024 * 1024;
/** Insert batches end at whichever limit comes first: research_tasks and research_artifacts rows average 140-190 KB, up to 9 MB. */
const BATCH_ROWS = 500;
const BATCH_BYTES = 16 * 1024 * 1024;
const CURSOR_ROWS = 100;
const STORAGE_PATH = /"(storage\/[^"\\]+)"/g;

/** Per table, the hash of each row as of this machine's last export. Lets import tell who changed a row. */
export type StoreBase = Record<string, Record<string, string>>;

/** Per table, id -> hash of the row as last pushed by the machine that deleted it. */
export type Tombstones = Record<string, Record<string, string>>;

export interface TableInfo {
  name: string; columns: string[]; types: string[]; idType: string; hasUpdatedAt: boolean; uniqueKeys: string[][]; selfKeys: string[];
  /** Unique keys that bind only rows with status 'accepted' (the current artifact or assumption per run and key). */
  acceptedKeys: string[][];
  /** Single-column foreign keys to other tables. */
  foreignKeys: Array<{ column: string; table: string }>;
}

export type Decision = "insert" | "update" | "keep" | "same" | "remap";
export interface Conflict { table: string; id: string; kept: "local" | "store"; reason?: string }
export interface SkippedFile { path: string; reason: string }
export interface ImportResult { inserted: number; updated: number; remapped: number; deleted: number; conflicts: Conflict[]; filesCopied: number; fileConflicts: string[]; skippedFiles: SkippedFile[] }
export interface ExportResult { tables: number; rows: number; files: number; tombstones: number; skippedFiles: SkippedFile[]; base: StoreBase }

export const rowHash = (line: string) => createHash("sha1").update(line).digest("hex").slice(0, 16);
/** 256 shards per table. Stores written with one-character shards still import: import reads every *.jsonl. */
export const shardOf = (id: string) => id.slice(0, 2).toLowerCase();
const megabytes = (bytes: number) => `${+(bytes / 2 ** 20).toFixed(2)} MB`;

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

/**
 * A store tombstone deletes the local row only when this machine hasn't changed it: it still matches the version the
 * other machine deleted, or the version this machine last pushed. A row changed here is kept, and the next export
 * writes it back, which lifts the tombstone.
 */
export function decideTombstone(input: { local?: string; tomb: string; base?: string }): "delete" | "keep" | "absent" {
  if (input.local === undefined) return "absent";
  return input.local === input.tomb || input.local === input.base ? "delete" : "keep";
}

/**
 * One table's tombstones after an export: the ones the store already had, plus rows this machine pushed before
 * (they are in its base) and has since deleted, minus any row this machine has now.
 */
export function nextTombstones(input: { previous?: Record<string, string>; base?: Record<string, string>; local: Record<string, unknown> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of [input.previous ?? {}, input.base ?? {}]) {
    for (const [id, hash] of Object.entries(source)) if (!Object.hasOwn(input.local, id)) out[id] = hash;
  }
  return out;
}

/** True for a partial unique index that binds only accepted rows, the one shape import knows how to settle. */
export const isAcceptedPredicate = (predicate: string) => /^\(*status = 'accepted'::text\)*$/.test(predicate.trim());

/**
 * Two machines accepted different rows for the same run and key. The later acceptance (accepted_at, else updated_at)
 * stays accepted and the other is superseded. A tie goes to the store row.
 */
export function acceptedWinner(store: { accepted_at?: unknown; updated_at?: unknown }, local: { accepted_at?: unknown; updated_at?: unknown }): "store" | "local" {
  const time = (r: { accepted_at?: unknown; updated_at?: unknown }) => Date.parse(String(r.accepted_at ?? r.updated_at ?? ""));
  return time(local) > time(store) ? "local" : "store";
}

/**
 * Refuses a push unless GitHub reports the store's remote as private. `visibility` is `gh repo view --json visibility`
 * output, or null when it could not be read. Returns the reason to refuse, or null.
 */
export function storeVisibilityError(visibility: string | null | undefined, remote: string): string | null {
  const v = (visibility ?? "").trim().toUpperCase();
  if (v === "PRIVATE") return null;
  if (!v) return `Refusing to push: could not confirm that ${remote} is private (gh repo view failed). Install and log in to the GitHub CLI, or pass --allow-public to push anyway.`;
  return `Refusing to push: ${remote} is ${v.toLowerCase()}, and the store holds every synced table and storage file. Make the repository private, or pass --allow-public to push anyway.`;
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
  // Columns of a table's foreign keys to itself (a superseded artifact, a parent session).
  const selfKeys = await sql`SELECT c.conrelid::regclass::text AS t, a.attname::text AS col FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = c.confrelid AND c.connamespace = 'public'::regnamespace`;
  const foreignKeys = await sql`SELECT c.conrelid::regclass::text AS t, c.confrelid::regclass::text AS "to", a.attname::text AS col FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.conrelid <> c.confrelid AND cardinality(c.conkey) = 1 AND c.connamespace = 'public'::regnamespace`;
  const partial = await sql`SELECT c.relname::text AS t, pg_get_expr(i.indpred, i.indrelid) AS pred, ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o) AS cols
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relnamespace = 'public'::regnamespace AND i.indisunique AND i.indexprs IS NULL AND i.indpred IS NOT NULL`;
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
    info.set(t, { name: t, columns: cols, types: own.map(r => `${r.c} ${r.type}`), idType: String(own.find(r => r.c === "id")!.type),
      hasUpdatedAt: cols.includes("updated_at"),
      uniqueKeys: uniques.filter(u => u.t === t).map(u => u.cols as string[]),
      selfKeys: selfKeys.filter(k => k.t === t).map(k => String(k.col)),
      acceptedKeys: cols.includes("status") ? partial.filter(u => u.t === t && isAcceptedPredicate(String(u.pred))).map(u => u.cols as string[]) : [],
      foreignKeys: foreignKeys.filter(k => k.t === t && tables.includes(String(k.to))).map(k => ({ column: String(k.col), table: String(k.to) })) });
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

/** A table's rows in id order, streamed through a cursor so a large table never sits in memory whole. */
async function* localRows(sql: Sql, table: string): AsyncGenerator<{ id: string; line: string }> {
  for await (const batch of sql`SELECT id::text AS id, to_jsonb(t)::text AS line FROM ${sql(table)} t ORDER BY id`.cursor(CURSOR_ROWS)) {
    for (const r of batch) yield { id: String(r.id), line: String(r.line) };
  }
}

type AcceptedRow = { id: string; accepted_at?: unknown; updated_at?: unknown };

/** Per local row, its hash, plus updated_at and unique-key values when the table has them. Holds no whole rows. */
async function localIndex(sql: Sql, table: TableInfo) {
  const hashes = new Map<string, string>();
  const updatedAt = new Map<string, string | null>();
  const byUnique = table.uniqueKeys.map(cols => ({ cols, index: new Map<string, string>() }));
  const byAccepted = table.acceptedKeys.map(cols => ({ cols, index: new Map<string, AcceptedRow>() }));
  for await (const r of localRows(sql, table.name)) {
    hashes.set(r.id, rowHash(r.line));
    if (!byUnique.length && !byAccepted.length && !table.hasUpdatedAt) continue;
    const row = JSON.parse(r.line);
    if (table.hasUpdatedAt) updatedAt.set(r.id, row.updated_at ?? null);
    for (const u of byUnique) { const key = uniqueValue(row, u.cols); if (key) u.index.set(key, r.id); }
    if (row.status !== "accepted") continue;
    for (const u of byAccepted) {
      const key = uniqueValue(row, u.cols);
      if (key) u.index.set(key, { id: r.id, accepted_at: row.accepted_at, updated_at: row.updated_at });
    }
  }
  return { hashes, updatedAt, byUnique, byAccepted };
}

/** Non-empty lines of a file. The next chunk is read only once these lines are consumed (readline queues 1,024). */
export async function* fileLines(path: string): AsyncGenerator<string> {
  let pending: string[] = [];
  for await (const chunk of createReadStream(path, { encoding: "utf8" }) as AsyncIterable<string>) {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0; start = end + 1, end = chunk.indexOf("\n", start)) {
      pending.push(chunk.slice(start, end));
      const line = pending.join("").replace(/\r$/, "");
      pending = [];
      if (line) yield line;
    }
    pending.push(chunk.slice(start));
  }
  const last = pending.join("").replace(/\r$/, "");
  if (last) yield last;
}

/**
 * Regular files under dir. Symlinks (dir itself included) and other special entries are never followed: they go to
 * `skipped`. A link planted in a backtest folder or a pushed store can't make sync read or write outside it.
 */
async function listFiles(dir: string, skipped: string[] = []): Promise<string[]> {
  const info = await lstat(dir).catch(() => null);
  if (!info) return [];
  if (!info.isDirectory()) { skipped.push(dir); return []; }
  const found: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) found.push(...await listFiles(path, skipped));
    else if (e.isFile()) found.push(path);
    else skipped.push(path);
  }
  return found;
}

/** Removes links a pushed store could plant to redirect export's writes out of the store folder. */
async function dropStoreLinks(storeDir: string) {
  const links: string[] = [];
  for (const name of ["tables", "files", "tombstones"]) await listFiles(join(storeDir, name), links);
  for (const link of [...links, join(storeDir, "manifest.json"), join(storeDir, ".gitattributes")]) await rm(link, { recursive: true, force: true });
}

/**
 * Writes one table's rows, given in id order, as shard files. A shard's rows arrive together (uuid order is hex
 * order), so only the current shard is held in memory. Throws before writing a shard over `maxFileBytes`.
 */
export function shardWriter(dir: string, maxFileBytes = MAX_FILE_BYTES) {
  const written = new Map<string, number>();
  let shard = "";
  let lines: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!lines.length) return;
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${shard}.jsonl`), lines.join("\n") + "\n");
    written.set(shard, bytes);
    lines = [];
  };
  return {
    async add(row: { id: string; line: string }) {
      const next = shardOf(row.id);
      if (next !== shard) { await flush(); shard = next; bytes = written.get(shard) ?? 0; }
      lines.push(row.line);
      bytes += Buffer.byteLength(row.line) + 1;
      if (bytes > maxFileBytes) {
        throw new Error(`Refusing to export: shard ${join(dir, shard)}.jsonl would pass ${megabytes(maxFileBytes)}, and GitHub rejects files over 100 MB. Shard this table more finely (shardOf) before syncing.`);
      }
    },
    close: flush,
  };
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

/** The store's tombstones: tombstones/<table>.txt, one "<id> <hash>" per line. Links are skipped, not followed. */
export async function readTombstones(storeDir: string): Promise<Tombstones> {
  const dir = join(resolve(storeDir), "tombstones");
  const out: Tombstones = {};
  for (const file of await listFiles(dir)) {
    const name = relative(dir, file);
    if (name.includes(sep) || !name.endsWith(".txt")) continue;
    const table: Record<string, string> = out[name.slice(0, -4)] = {};
    for await (const line of fileLines(file)) {
      const [id, hash] = line.split(" ");
      if (id && hash) table[id] = hash;
    }
  }
  return out;
}

/** Rewrites tombstones/ from scratch, one sorted file per table that has any. Returns how many it wrote. */
export async function writeTombstones(storeDir: string, tombstones: Tombstones) {
  const dir = join(resolve(storeDir), "tombstones");
  await rm(dir, { recursive: true, force: true });
  let count = 0;
  for (const [table, ids] of Object.entries(tombstones)) {
    const lines = Object.keys(ids).sort().map(id => `${id} ${ids[id]}`);
    if (!lines.length) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${table}.txt`), lines.join("\n") + "\n");
    count += lines.length;
  }
  return count;
}

/**
 * Writes this database over the store folder. `base` is the base from this machine's last pushed export: rows in it
 * that are gone here become tombstones, so the deletion reaches the other machines instead of coming back.
 */
export async function exportStore(sql: Sql, options: { storeDir: string; projectRoot: string; base?: StoreBase; maxFileBytes?: number }): Promise<ExportResult> {
  const storeDir = resolve(options.storeDir);
  const tables = await describeTables(sql);
  await dropStoreLinks(storeDir);
  const previousTombstones = await readTombstones(storeDir);
  const tombstones: Tombstones = {};
  const base: StoreBase = {};
  const referenced = new Set<string>();
  let rows = 0;
  await mkdir(join(storeDir, "tables"), { recursive: true });
  for (const table of tables) {
    const hashes: Record<string, string> = base[table.name] = {};
    const dir = join(storeDir, "tables", table.name);
    await rm(dir, { recursive: true, force: true });
    const shards = shardWriter(dir, options.maxFileBytes);
    for await (const row of localRows(sql, table.name)) {
      hashes[row.id] = rowHash(row.line);
      for (const m of row.line.matchAll(STORAGE_PATH)) referenced.add(m[1]);
      await shards.add(row);
      rows += 1;
    }
    await shards.close();
    tombstones[table.name] = nextTombstones({ previous: previousTombstones[table.name], base: options.base?.[table.name], local: hashes });
  }
  const tombstoneCount = await writeTombstones(storeDir, tombstones);
  // Tables that no longer exist here leave no stale directory behind.
  const names = new Set(tables.map(t => t.name));
  for (const entry of await readdir(join(storeDir, "tables"))) if (!names.has(entry)) await rm(join(storeDir, "tables", entry), { recursive: true, force: true });

  const mirrored = await mirrorFiles(referenced, options);

  // Stored bytes must survive checkout unchanged: source files are checked against their file_hash.
  await writeFile(join(storeDir, ".gitattributes"), "* -text\n");
  const manifest = { format: STORE_FORMAT, excludedTables: [...EXCLUDED_TABLES], schema: schemaOf(tables) };
  await writeFile(join(storeDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { tables: tables.length, rows, files: mirrored.files, tombstones: tombstoneCount, skippedFiles: mirrored.skipped, base };
}

/**
 * Mirrors the storage/ files rows name into the store's files/ folder. A referenced directory (a backtest run folder)
 * goes in whole. Only regular files whose real path stays inside their storage/<dir> are copied, so a link that
 * sandboxed backtest code wrote can't carry ~/.ssh or .env.local into the store. storage/<dir> itself may be a link:
 * worktrees share the main checkout's storage that way.
 */
export async function mirrorFiles(referenced: Iterable<string>, options: { storeDir: string; projectRoot: string; maxFileBytes?: number }) {
  const filesDir = join(resolve(options.storeDir), "files");
  const storageDir = resolve(options.projectRoot, "storage");
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const wanted = new Set<string>();
  const skipped = new Map<string, string>();
  const links: string[] = [];
  const roots = new Map<string, Promise<string | null>>();
  for (const ref of referenced) {
    const source = resolve(options.projectRoot, ref);
    if (!source.startsWith(storageDir + sep)) continue;
    const [first, ...rest] = relative(storageDir, source).split(sep);
    if (!rest.length) { skipped.set(ref, "not inside a storage/ folder"); continue; }
    if (!roots.has(first)) roots.set(first, realpath(join(storageDir, first)).catch(() => null));
    const root = await roots.get(first);
    if (!root) continue;
    let info;
    try { info = await stat(source); } catch { continue; }
    for (const file of info.isDirectory() ? await listFiles(source, links) : [source]) {
      const rel = posix(relative(options.projectRoot, file));
      const real = await realpath(file).catch(() => null);
      if (!real?.startsWith(root + sep)) { skipped.set(rel, `resolves outside storage/${first}`); continue; }
      if ((await stat(real)).size > maxFileBytes) { skipped.set(rel, `over ${megabytes(maxFileBytes)}, GitHub's limit`); continue; }
      wanted.add(rel);
      const target = join(filesDir, rel);
      if (await sameFile(real, target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(real, target);
    }
  }
  for (const link of links) skipped.set(posix(relative(options.projectRoot, link)), "symlink or special file");
  for (const file of await listFiles(filesDir)) if (!wanted.has(posix(relative(filesDir, file)))) await rm(file);
  return { files: wanted.size, skipped: [...skipped].map(([path, reason]) => ({ path, reason })) };
}

/**
 * Copies store files this machine lacks into storage/. Only regular files under files/storage/<dir>/ are taken, and
 * only into a folder whose real path stays inside that storage/<dir>, so a pushed store can't write code or config
 * anywhere else in the project. A file that differs is left alone and reported.
 */
export async function importFiles(options: { storeDir: string; projectRoot: string }) {
  const filesDir = join(resolve(options.storeDir), "files");
  const storageDir = resolve(options.projectRoot, "storage");
  const result = { copied: 0, conflicts: [] as string[], skipped: [] as SkippedFile[] };
  const links: string[] = [];
  for (const file of await listFiles(filesDir, links)) {
    const rel = posix(relative(filesDir, file));
    const [top, first, ...rest] = rel.split("/");
    if (top !== "storage" || !rest.length) { result.skipped.push({ path: rel, reason: "outside storage/" }); continue; }
    const target = resolve(options.projectRoot, rel);
    try {
      await stat(target);
      if (!await sameFile(file, target)) result.conflicts.push(rel);
      continue;
    } catch { /* missing here: copy it */ }
    try {
      await mkdir(dirname(target), { recursive: true });
      const [root, dir] = await Promise.all([realpath(join(storageDir, first)), realpath(dirname(target))]);
      if (dir !== root && !dir.startsWith(root + sep)) { result.skipped.push({ path: rel, reason: `resolves outside storage/${first}` }); continue; }
      await copyFile(file, target, constants.COPYFILE_EXCL);
      result.copied += 1;
    } catch (error) {
      result.skipped.push({ path: rel, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const link of links) result.skipped.push({ path: posix(relative(filesDir, link)), reason: "symlink or special file" });
  return result;
}

/**
 * Each table's shard files in name order: any tables/<table>/*.jsonl, so one-character shards from older stores read
 * the same as two-character ones. Links in a pushed store are skipped, not followed.
 */
export async function storeShards(storeDir: string) {
  const tablesDir = join(resolve(storeDir), "tables");
  const links: string[] = [];
  const shardFiles = new Map<string, string[]>();
  for (const file of (await listFiles(tablesDir, links)).sort()) {
    const [table, name, ...deeper] = relative(tablesDir, file).split(sep);
    if (name?.endsWith(".jsonl") && !deeper.length) (shardFiles.get(table) ?? shardFiles.set(table, []).get(table)!).push(file);
  }
  const skipped: SkippedFile[] = links.map(link => ({ path: posix(relative(resolve(storeDir), link)), reason: "symlink or special file" }));
  return { shardFiles, skipped };
}

/**
 * Orders a table's accepted rows so none goes in before a row of the same table it points at: import inserts in
 * batches, and Postgres checks foreign keys per statement. A row whose parent hasn't gone in yet waits. Rows still
 * waiting at the end (a cycle, or a parent that is missing) go in together in the last statement, where Postgres
 * checks them.
 */
export function parentFirst(keys: string[], exists: (id: string) => boolean) {
  const added = new Set<string>();
  let waiting: Array<{ id: string; line: string; parents: string[] }> = [];
  const take = (id: string, line: string) => { if (keys.length) added.add(id); return line; };
  return {
    /** The line, when every row it points at is in already; otherwise it waits. */
    add(row: Record<string, unknown>, line: string): string[] {
      const id = String(row.id);
      const parents = keys.map(k => row[k]).filter((p): p is string => typeof p === "string" && p !== id && !exists(p) && !added.has(p));
      if (parents.length) { waiting.push({ id, line, parents }); return []; }
      return [take(id, line)];
    },
    /** Waiting lines, each after its parents, then those left over, which must share one statement. */
    rest(): { ordered: string[]; leftover: string[] } {
      const ordered: string[] = [];
      for (let progress = true; progress;) {
        progress = false;
        waiting = waiting.filter(w => {
          if (!w.parents.every(p => added.has(p))) return true;
          ordered.push(take(w.id, w.line));
          progress = true;
          return false;
        });
      }
      return { ordered, leftover: waiting.map(w => w.line) };
    },
  };
}

function uniqueValue(row: Record<string, unknown>, cols: string[]): string | null {
  const values = cols.map(c => row[c]);
  return values.some(v => v === null || v === undefined) ? null : JSON.stringify(values);
}

const DELETE_BATCH = 5000;

/**
 * Applies the store's tombstones, children first. A row changed here since it was deleted elsewhere is kept. A delete
 * that a local row still depends on (a foreign key) is kept too, row by row, instead of aborting the import.
 * Returns the deleted ids per table.
 */
async function applyTombstones(tx: postgres.TransactionSql, tables: TableInfo[], tombstones: Tombstones, base: StoreBase, result: ImportResult) {
  const deleted = new Map<string, Set<string>>();
  for (const table of [...tables].reverse()) {
    const tombs = tombstones[table.name] ?? {};
    const ids = Object.keys(tombs);
    const gone = new Set<string>();
    deleted.set(table.name, gone);
    const match = `id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::"${table.idType}")`;
    const remove = (q: postgres.TransactionSql, list: string[]) => q.unsafe(`DELETE FROM "${table.name}" WHERE ${match}`, [JSON.stringify(list)]);
    for (let at = 0; at < ids.length; at += DELETE_BATCH) {
      const chunk = ids.slice(at, at + DELETE_BATCH);
      const rows = await tx.unsafe(`SELECT id::text AS id, to_jsonb(t)::text AS line FROM "${table.name}" t WHERE ${match}`, [JSON.stringify(chunk)]);
      const doomed: string[] = [];
      for (const r of rows) {
        const id = String(r.id);
        const decision = decideTombstone({ local: rowHash(String(r.line)), tomb: tombs[id], base: base[table.name]?.[id] });
        if (decision === "delete") doomed.push(id);
        else result.conflicts.push({ table: table.name, id, kept: "local", reason: "deleted on the other machine, changed here" });
      }
      if (!doomed.length) continue;
      try {
        await tx.savepoint(sp => remove(sp, doomed));
        for (const id of doomed) gone.add(id);
      } catch {
        for (const id of doomed) {
          try {
            await tx.savepoint(sp => remove(sp, [id]));
            gone.add(id);
          } catch {
            result.conflicts.push({ table: table.name, id, kept: "local", reason: "deleted on the other machine, still referenced here" });
          }
        }
      }
    }
    result.deleted += gone.size;
  }
  return deleted;
}

/**
 * Merges the store into the local database in one transaction, so a failure changes nothing. Tombstones are applied
 * first, then rows are upserted in foreign-key order. A store row whose unique key (an asset slug, a file hash, a
 * seeded definition) matches a different local row is taken to be that row: its id is rewritten to the local id
 * everywhere it appears. When both machines accepted a row for the same accepted-only unique key, the later
 * acceptance stays accepted and the other becomes superseded. A store row that points at a row deleted here is left
 * out and reported.
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
  const result: ImportResult = { inserted: 0, updated: 0, remapped: 0, deleted: 0, conflicts: [], filesCopied: 0, fileConflicts: [], skippedFiles: [] };
  const tombstones = await readTombstones(storeDir);
  const remap = new Map<string, string>();

  const { shardFiles, skipped } = await storeShards(storeDir);
  result.skippedFiles.push(...skipped);

  await sql.begin(async tx => {
    // Rows absent here because this machine deleted them: a store row that points at one is left out.
    const deletedHere = await applyTombstones(tx, tables, tombstones, options.base, result);
    for (const table of tables) {
      const gone = deletedHere.get(table.name) ?? new Set<string>();
      deletedHere.set(table.name, gone);
      const files = shardFiles.get(table.name);
      if (!files) continue;
      // Ids matched in earlier tables; matches found in this table apply from the next one on.
      const pairs = [...remap];
      const rewrite = (line: string) => {
        for (const [from, to] of pairs) if (line.includes(from)) line = line.split(from).join(to);
        return line;
      };
      const here = await localIndex(tx as unknown as Sql, table);
      const base = options.base[table.name] || {};
      const assignments = table.columns.filter(c => c !== "id").map(c => `"${c}" = EXCLUDED."${c}"`).join(", ");
      // Accepted local rows demoted only to let a store row in, restored after the table's last insert.
      const restore: Array<{ demote: string; promote: string }> = [];
      let accepted: string[] = [];
      let acceptedBytes = 0;
      const flush = async () => {
        if (!accepted.length) return;
        await tx.unsafe(`INSERT INTO "${table.name}" SELECT * FROM json_populate_recordset(NULL::"${table.name}", $1::text::json)
          ON CONFLICT (id) DO ${assignments ? `UPDATE SET ${assignments}` : "NOTHING"}`, [`[${accepted.join(",")}]`]);
        accepted = [];
        acceptedBytes = 0;
      };
      const accept = async (lines: string[], batched = true) => {
        for (const line of lines) {
          accepted.push(line);
          acceptedBytes += line.length;
          if (batched && (accepted.length >= BATCH_ROWS || acceptedBytes >= BATCH_BYTES)) await flush();
        }
      };
      const order = parentFirst(table.selfKeys, id => here.hashes.has(id));
      for (const file of files) for await (const raw of fileLines(file)) {
        const line = rewrite(raw);
        const row = JSON.parse(line);
        const id = String(row.id);
        const local = here.hashes.get(id);
        if (local === undefined) {
          const match = here.byUnique.map(u => { const key = uniqueValue(row, u.cols); return key ? u.index.get(key) : undefined; }).find(Boolean);
          if (match) { remap.set(id, match); result.remapped += 1; continue; }
        }
        const { decision, conflict } = decideRow({ line, local, base: base[id],
          storeUpdatedAt: row.updated_at ?? null, localUpdatedAt: here.updatedAt.get(id) ?? null });
        if (conflict) result.conflicts.push({ table: table.name, id, kept: conflict });
        if (decision === "keep" && local === undefined) gone.add(id);
        if (decision !== "insert" && decision !== "update") continue;
        const parent = table.foreignKeys.find(k => typeof row[k.column] === "string" && deletedHere.get(k.table)?.has(row[k.column]));
        if (parent) {
          gone.add(id);
          result.conflicts.push({ table: table.name, id, kept: "local", reason: `points at ${parent.table} ${row[parent.column]}, deleted here` });
          continue;
        }
        if (row.status === "accepted") {
          for (const u of here.byAccepted) {
            const key = uniqueValue(row, u.cols);
            const current = key ? u.index.get(key) : undefined;
            if (!key || !current || current.id === id) continue;
            const winner = acceptedWinner(row, current);
            // Demote the local row whoever wins: the insert would hit the unique index otherwise.
            await tx.unsafe(`UPDATE "${table.name}" SET status = 'superseded'${winner === "store" && table.hasUpdatedAt ? ", updated_at = NOW()" : ""} WHERE id = $1`, [current.id]);
            if (winner === "local") restore.push({ demote: id, promote: current.id });
            else u.index.set(key, { id, accepted_at: row.accepted_at, updated_at: row.updated_at });
            result.conflicts.push({ table: table.name, id, kept: winner, reason: "both machines accepted a row for the same key" });
          }
        }
        if (decision === "insert") result.inserted += 1;
        if (decision === "update") result.updated += 1;
        await accept(order.add(row, line));
      }
      const { ordered, leftover } = order.rest();
      await accept(ordered);
      await accept(leftover, false);
      await flush();
      for (const r of restore) {
        await tx.unsafe(`UPDATE "${table.name}" SET status = 'superseded'${table.hasUpdatedAt ? ", updated_at = NOW()" : ""} WHERE id = $1`, [r.demote]);
        await tx.unsafe(`UPDATE "${table.name}" SET status = 'accepted' WHERE id = $1`, [r.promote]);
      }
    }
  });

  const files = await importFiles(options);
  result.filesCopied = files.copied;
  result.fileConflicts = files.conflicts;
  result.skippedFiles.push(...files.skipped);
  return result;
}

export async function readBase(path: string): Promise<StoreBase> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
}

export async function writeBase(path: string, base: StoreBase) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(base));
}
