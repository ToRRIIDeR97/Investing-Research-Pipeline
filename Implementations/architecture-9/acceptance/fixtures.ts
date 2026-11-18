import crypto from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import postgres from "postgres";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";

/** Tests run from the repository root. */
export const ROOT = resolve(process.cwd());
export const DB = process.env.RUN_DB_INTEGRATION === "1";

/** A stage ledger for readyStages: every stage pending unless a status is given; run-type skips applied. */
export function ledger(statuses: Record<string, string> = {}, runType = "deep_dive") {
  return STAGE_CONFIGS.map(stage => ({ stage_key: stage.key,
    status: statuses[stage.key] ?? (stage.skipForRunTypes.includes(runType) ? "skipped" : "pending") }));
}
export const completed = (keys: string[]) => Object.fromEntries(keys.map(key => [key, "completed"]));

/** Source files under src/, as repo-relative forward-slash paths. */
export function sourceFiles(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [relative(ROOT, path).replace(/\\/g, "/")] : [];
  });
}
export const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
/** Code lines only: block and line comments removed. */
export const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join("\n");

/** One asset with its listing, and runs created through the same inserts the lifecycle suite uses. */
export function runFixture(label: string) {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const assetId = crypto.randomUUID(), instrumentId = crypto.randomUUID();
  const runIds: string[] = [];
  let profileId = "";
  return {
    sql, runIds,
    async setup() {
      [{ id: profileId }] = await sql`SELECT id FROM research_profiles WHERE profile_key = 'financials' LIMIT 1`;
      await sql`INSERT INTO assets (id, canonical_name, slug, primary_profile_id, status, asset_kind, base_currency)
        VALUES (${assetId}, ${`${label} Test Co`}, ${`${label}-${assetId.slice(0, 8)}`}, ${profileId}, 'active', 'equity', 'USD')`;
      await sql`INSERT INTO instruments (id, asset_id, name, instrument_type) VALUES (${instrumentId}, ${assetId}, ${`${label} common`}, 'equity')`;
      await sql`INSERT INTO listings (id, instrument_id, exchange, symbol, is_primary)
        VALUES (${crypto.randomUUID()}, ${instrumentId}, 'NASDAQ', ${`A9${assetId.slice(0, 4).toUpperCase()}`}, true)`;
    },
    /** Insert a run row only; the caller creates its stages. */
    async newRun(status = "pending", metadata: Record<string, unknown> = {}, runType = "deep_dive") {
      const runId = crypto.randomUUID();
      runIds.push(runId);
      const cutoff = new Date().toISOString();
      await sql`INSERT INTO research_runs (id, asset_id, run_type, status, research_question, requested_by, profile_id, profile_version,
          source_cutoff_at, market_data_cutoff_at, budget_limit_usd, pipeline_version, metadata_json)
        VALUES (${runId}, ${assetId}, ${runType}, ${status}, 'Architecture test?', 'architecture-test', ${profileId}, 1,
          ${cutoff}, ${cutoff}, 10.00, 3, ${sql.json({ acceptance_provider: "mock", ...metadata } as any)})`;
      await sql`INSERT INTO asset_profile_assignments (asset_id, research_run_id, profile_id, assignment_reason, assigned_by, confidence, status)
        VALUES (${assetId}, ${runId}, ${profileId}, 'Run-scoped assignment', 'architecture-test', '1.0', 'active')`;
      return runId;
    },
    async teardown() {
      const tables = (await sql`SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'research_run_id'`).map(row => String(row.table_name));
      for (let pass = 0; pass < 4; pass++) for (const name of [...tables, "research_runs"]) {
        const column = name === "research_runs" ? "id" : "research_run_id";
        await sql`DELETE FROM ${sql(name)} WHERE ${sql(column)} = ANY(${runIds}::uuid[])`.catch(() => undefined);
      }
      await sql`DELETE FROM asset_profile_assignments WHERE asset_id = ${assetId}`.catch(() => undefined);
      await sql`DELETE FROM listings WHERE instrument_id = ${instrumentId}`.catch(() => undefined);
      await sql`DELETE FROM instruments WHERE id = ${instrumentId}`.catch(() => undefined);
      await sql`DELETE FROM assets WHERE id = ${assetId}`.catch(() => undefined);
      await sql.end({ timeout: 5 });
    },
  };
}
