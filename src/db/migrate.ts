import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as coreSchema from "./schema/core";
import * as profilesSchema from "./schema/profiles";
import * as workflowSchema from "./schema/workflow";
import * as corpusSchema from "./schema/corpus";
import * as evidenceSchema from "./schema/evidence";
import * as metricsSchema from "./schema/metrics";
import * as valuationSchema from "./schema/valuation";
import * as thesisSchema from "./schema/thesis";
import * as aiSchema from "./schema/ai";

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
