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

const connectionString = process.env.DATABASE_URL!;

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
