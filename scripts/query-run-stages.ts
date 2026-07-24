import postgres from "postgres";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;

  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    const rawValue = valueParts.join("=").trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  const [latestRun] = await sql`
    SELECT id, status, failure_reason FROM research_runs
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!latestRun) {
    console.log("No research runs found.");
    await sql.end();
    return;
  }

  console.log("Latest Run:", latestRun);

  const claims = await sql`
    SELECT id, claim_text, claim_type, claim_category, review_status
    FROM evidence_claims
    WHERE research_run_id = ${latestRun.id}
  `;
  console.log(`\nPersisted Evidence Claims (${claims.length}):`);
  console.log(JSON.stringify(claims.slice(0, 5), null, 2));

  const links = await sql`
    SELECT el.id, el.evidence_claim_id, el.source_location_id
    FROM evidence_links el
    JOIN evidence_claims ec ON ec.id = el.evidence_claim_id
    WHERE ec.research_run_id = ${latestRun.id}
  `;
  console.log(`\nPersisted Evidence Links (${links.length}):`);
  console.log(JSON.stringify(links.slice(0, 5), null, 2));

  const stages = await sql`
    SELECT stage_key, status, failure_reason, validation_result_json
    FROM research_stages
    WHERE research_run_id = ${latestRun.id}
    ORDER BY stage_order
  `;
  console.log("\nStages:");
  console.log(JSON.stringify(stages, null, 2));

  await sql.end();
}

main().catch(console.error);
