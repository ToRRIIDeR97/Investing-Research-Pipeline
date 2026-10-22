/**
 * npm run monitor:check [-- asset-slug ...]
 *
 * For each asset with a completed run: new 10-Q/10-K filings on EDGAR after the run's source cutoff, their
 * statements, the monitoring dashboard scored on them, and whether a refresh is due. The result is stored in
 * asset_monitor_checks and shown on the asset page. Free: no model call, and no run is queued or started.
 */
import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { runMonitorCheck } from "../src/lib/research/monitoring/monitor-check";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL || !existsSync(".env.local")) return;
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find(l => /^DATABASE_URL=/.test(l.trim()));
  if (line) process.env.DATABASE_URL = line.trim().slice("DATABASE_URL=".length).replace(/^['"]|['"]$/g, "");
}

async function main() {
  loadDatabaseUrl();
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL or add it to .env.local");
  const slugs = process.argv.slice(2).filter(arg => /^[a-z0-9-]+$/.test(arg));
  const sql = postgres(process.env.DATABASE_URL, { max: 2 });
  try {
    const results = await runMonitorCheck(sql, { slugs });
    if (!results.length) console.log("No asset has a completed run to check.");
    for (const r of results) {
      console.log(`${r.slug}: ${r.status}${r.filings.length ? ` (${r.filings.length} new filing${r.filings.length === 1 ? "" : "s"})` : ""}`);
      for (const reason of r.reasons) console.log(`  - ${reason}`);
      for (const k of r.kpis) console.log(`  ${k.status.padEnd(13)} ${k.kpi}: ${k.reason}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
