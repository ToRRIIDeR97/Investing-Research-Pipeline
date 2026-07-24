import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import * as coreSchema from "./schema/core";
import * as profilesSchema from "./schema/profiles";
import * as workflowSchema from "./schema/workflow";
import * as corpusSchema from "./schema/corpus";
import * as evidenceSchema from "./schema/evidence";
import * as metricsSchema from "./schema/metrics";
import * as valuationSchema from "./schema/valuation";
import * as thesisSchema from "./schema/thesis";
import * as aiSchema from "./schema/ai";
import * as backtestingSchema from "./schema/backtesting";
import * as researchV2Schema from "./schema/research-v2";
import * as researchArtifactsSchema from "./schema/research-artifacts";
import * as sourceIntelligenceSchema from "./schema/source-intelligence";
import * as marketDataSchema from "./schema/market-data";
import * as researchRunJobsSchema from "./schema/research-run-jobs";

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

const schema = {
  ...coreSchema,
  ...profilesSchema,
  ...workflowSchema,
  ...corpusSchema,
  ...evidenceSchema,
  ...metricsSchema,
  ...valuationSchema,
  ...thesisSchema,
  ...aiSchema,
  ...backtestingSchema,
  ...researchV2Schema,
  ...researchArtifactsSchema,
  ...sourceIntelligenceSchema,
  ...marketDataSchema,
  ...researchRunJobsSchema,
};

async function main() {
  const client = postgres(process.env.DATABASE_URL!);
  const db = drizzle(client, { schema });

  console.log("Running migrations...");

  await migrate(db, { migrationsFolder: "./drizzle" });

  console.log("Migrations complete!");
  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
