import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
import * as researchRunJobsSchema from "./schema/research-run-jobs";

export const schema = {
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
  ...researchRunJobsSchema,
};

const connectionString = process.env.DATABASE_URL!;

// Keep hot reloads from creating a new connection pool for every module update.
const globalForDb = globalThis as typeof globalThis & { researchDbClient?: ReturnType<typeof postgres> };
const client = globalForDb.researchDbClient ?? postgres(connectionString);
if (process.env.NODE_ENV !== "production") globalForDb.researchDbClient = client;
export const db = drizzle(client, { schema });
