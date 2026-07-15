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
  const rows = await sql`
    SELECT DISTINCT ON (a.id) a.id, a.canonical_name, a.slug, a.primary_profile_id, l.symbol
    FROM assets a
    LEFT JOIN instruments i ON i.asset_id = a.id
    LEFT JOIN listings l ON l.instrument_id = i.id AND l.is_primary = true
    ORDER BY a.id
  `;
  console.log("Assets:", JSON.stringify(rows, null, 2));

  const profiles = await sql`SELECT id, profile_key, name, version FROM research_profiles`;
  console.log("Profiles:", JSON.stringify(profiles, null, 2));

  await sql.end();
}

main().catch(console.error);
