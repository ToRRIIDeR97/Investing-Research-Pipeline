import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schemas";

export { schema };

const connectionString = process.env.DATABASE_URL!;

// Keep hot reloads from creating a new connection pool for every module update.
const globalForDb = globalThis as typeof globalThis & { researchDbClient?: ReturnType<typeof postgres> };
const client = globalForDb.researchDbClient ?? postgres(connectionString);
if (process.env.NODE_ENV !== "production") globalForDb.researchDbClient = client;
export const db = drizzle(client, { schema });
// The same long-lived pool for raw queries on hot API paths. Scripts and the worker keep their own clients.
export const sqlClient = client;
