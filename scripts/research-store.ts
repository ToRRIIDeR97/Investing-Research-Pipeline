// Git-backed research store. Each machine keeps its own Postgres; the research-store branch carries research between them.
//   npx tsx scripts/research-store.ts [sync|export|import] [--store research-store] [--no-push]
// sync: fetch the branch, import it, export this database over it, commit and push. See docs/operations.md.
import postgres from "postgres";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { hostname } from "os";
import { join, resolve } from "path";
import { exportStore, importStore, liveWorkerIds, readBase, writeBase } from "../src/lib/maintenance/research-store";

const BRANCH = "research-store";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const git = (args: string[], cwd = process.cwd()) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (args: string[], cwd?: string) => { try { git(args, cwd); return true; } catch { return false; } };

/** Checks the branch out into the store folder, creating it on first use. */
function ensureWorktree(storeDir: string) {
  if (existsSync(join(storeDir, ".git"))) return;
  if (gitOk(["fetch", "origin", BRANCH])) git(["worktree", "add", storeDir, BRANCH]);
  else git(["worktree", "add", "--orphan", "-b", BRANCH, storeDir]);
}

/**
 * Moves the store to the pushed branch. The store is derived from the database, so a local commit that never got
 * pushed is safe to drop: its rows are still here and the export after the import writes them again.
 */
function pullStore(storeDir: string) {
  if (!gitOk(["fetch", "origin", BRANCH], storeDir)) return;
  git(["reset", "--hard", `origin/${BRANCH}`], storeDir);
}

async function main() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");
  if (!process.env.DATABASE_URL && process.env.WINDOWS_DATABASE_ADMIN_URL) {
    const url = new URL(process.env.WINDOWS_DATABASE_ADMIN_URL);
    url.pathname = "/research_os";
    process.env.DATABASE_URL = url.toString();
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const command = ["sync", "export", "import"].find(c => process.argv.slice(2).includes(c)) ?? "sync";
  const projectRoot = process.cwd();
  const storeDir = resolve(option("--store") ?? BRANCH);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const database = new URL(process.env.DATABASE_URL).pathname.slice(1);
  const basePath = join(projectRoot, "storage", `.research-store-base.${database}.json`);
  try {
    if (command !== "export") {
      const workers = await liveWorkerIds(sql);
      if (workers.length) throw new Error(`Refusing to import: research worker ${workers.join(", ")} is polling ${database}. Stop it first.`);
    }
    if (command === "sync") { ensureWorktree(storeDir); pullStore(storeDir); }
    if (command !== "export" && existsSync(join(storeDir, "manifest.json"))) {
      const r = await importStore(sql, { storeDir, projectRoot, base: await readBase(basePath) });
      console.log(`Imported into ${database}: ${r.inserted} new rows, ${r.updated} updated, ${r.remapped} matched to existing rows, ${r.filesCopied} files copied.`);
      for (const c of r.conflicts) console.log(`  both changed ${c.table} ${c.id}: kept the ${c.kept} copy`);
      for (const f of r.fileConflicts) console.log(`  file differs, kept this machine's copy: ${f}`);
    }
    if (command === "import") return;
    const r = await exportStore(sql, { storeDir, projectRoot });
    await writeBase(basePath, r.base);
    console.log(`Exported ${database}: ${r.rows} rows from ${r.tables} tables, ${r.files} files to ${storeDir}.`);
    for (const f of r.skippedFiles) console.log(`  skipped (over 95 MB, GitHub's limit): ${f}`);
    if (command !== "sync") return;
    git(["add", "-A"], storeDir);
    if (!git(["status", "--porcelain"], storeDir)) { console.log("Store unchanged; nothing to push."); return; }
    git(["commit", "-m", `Sync research from ${hostname()}`], storeDir);
    if (process.argv.includes("--no-push")) { console.log("Committed; not pushed (--no-push)."); return; }
    git(["push", "-u", "origin", BRANCH], storeDir);
    console.log(`Pushed ${BRANCH}.`);
  } finally {
    await sql.end();
  }
}

main().catch(error => { console.error(error.message || error); process.exit(1); });
