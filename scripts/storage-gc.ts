// Storage cleanup. Dry run by default: prints what would be removed and the bytes reclaimed.
//   npx tsx scripts/storage-gc.ts [--storage <dir>] [--min-age-hours 24] [--parse-texts] [--list] [--apply]
// References are read from every database on DATABASE_URL's server that has a source_documents table, since
// test and worktree databases share storage/ through symlinks. See docs/operations.md.
import postgres from "postgres";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { applyStorageGc, planStorageGc, type GcDatabase } from "../src/lib/maintenance/storage-gc";

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

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function databases(baseUrl: string): Promise<GcDatabase[]> {
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  const names = (await admin`SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`).map(r => String(r.datname));
  await admin.end();
  const found: GcDatabase[] = [];
  for (const name of names) {
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    // A database that cannot be read could hold references, so the run stops rather than guess.
    const [row] = await sql`SELECT to_regclass('public.source_documents') IS NOT NULL AS present`.catch(error => {
      throw new Error(`Cannot read database ${name} (${error.message}); its references are unknown, so nothing is planned.`);
    });
    if (row.present) found.push({ name, sql });
    else await sql.end();
  }
  return found;
}

async function main() {
  loadEnvFile(".env.local");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const apply = process.argv.includes("--apply");
  const minAgeHours = Number(option("--min-age-hours") ?? 24);
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) throw new Error("--min-age-hours must be a number of hours");
  const storageRoot = resolve(option("--storage") ?? "storage");
  const dbs = await databases(process.env.DATABASE_URL);
  try {
    console.log(`${apply ? "APPLY" : "DRY RUN"}: storage ${storageRoot}; references from ${dbs.map(db => db.name).join(", ")}`);
    if (apply) {
      for (const db of dbs) {
        const live = await db.sql`SELECT worker_id FROM research_worker_heartbeats
          WHERE status = 'healthy' AND last_seen_at > NOW() - INTERVAL '30 seconds'`.catch(() => []);
        if (live.length) throw new Error(`Refusing to apply: research worker ${live.map(r => r.worker_id).join(", ")} is polling ${db.name}. Stop it first.`);
      }
    }
    const plan = await planStorageGc(dbs, { storageRoot, minAgeMs: minAgeHours * 3_600_000, includeParseTexts: process.argv.includes("--parse-texts") });

    const freed = new Set(plan.repoints.map(r => resolve(storageRoot, "..", r.from)));
    const freedBytes = plan.candidates.filter(c => freed.has(c.path)).reduce((sum, c) => sum + c.bytes, 0);
    console.log(`\nSEC filing duplicates: ${plan.repoints.length} rows would point at their first intact copy; ` +
      `${plan.candidates.filter(c => freed.has(c.path)).length} redundant files (${mb(freedBytes)}) become removable.`);
    for (const db of new Set(plan.repoints.map(r => r.database))) console.log(`  ${db}: ${plan.repoints.filter(r => r.database === db).length} rows`);
    if (plan.skippedDuplicates.length) console.log(`  left alone: ${plan.skippedDuplicates.length} (${[...new Set(plan.skippedDuplicates.map(s => s.reason))].join("; ")})`);
    if (process.argv.includes("--list")) for (const s of plan.skippedDuplicates) console.log(`    ${s.database} ${s.sourceId}: ${s.reason}`);
    if (plan.includeParseTexts) console.log(`Parse-text paths cleared: ${plan.parseTextRows.map(p => `${p.database} ${p.rows}`).join(", ")}`);

    console.log(`\nUnreferenced in every database (older than ${minAgeHours} h):`);
    let total = 0;
    for (const category of ["sources", "parses", "exports", "backtests"] as const) {
      const items = plan.candidates.filter(c => c.category === category);
      const bytes = items.reduce((sum, c) => sum + c.bytes, 0);
      total += bytes;
      console.log(`  storage/${category}: ${items.length} entries, ${mb(bytes)}`);
      for (const item of process.argv.includes("--list") ? items : items.slice(0, 5)) console.log(`    ${item.path} (${mb(item.bytes)})`);
    }
    console.log(`  newer than the cutoff, kept: ${plan.tooNew}`);
    console.log(`\nTotal reclaimable: ${plan.candidates.length} entries, ${mb(total)}`);

    if (!apply) {
      console.log("\nNothing changed. Re-run with --apply to repoint the duplicates and delete these entries.");
      return;
    }
    const result = await applyStorageGc(dbs, plan);
    console.log(`\nApplied: ${result.repointed} rows repointed, ${result.deleted} entries deleted, ${mb(result.bytes)} reclaimed.`);
  } finally {
    await Promise.all(dbs.map(db => db.sql.end()));
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
