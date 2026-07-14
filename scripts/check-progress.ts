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

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    console.log("=== Active pg_stat_activity ===");
    const activity = await sql`
      SELECT pid, state, query, age(clock_timestamp(), query_start) as age 
      FROM pg_stat_activity 
      WHERE state != 'idle'
    `;
    console.log(JSON.stringify(activity, null, 2));

    console.log("\n=== Active pg_locks ===");
    const locks = await sql`
      SELECT pid, mode, granted 
      FROM pg_locks 
      WHERE NOT granted
    `;
    console.log(JSON.stringify(locks, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch(console.error);
