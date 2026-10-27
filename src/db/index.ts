import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schemas";

export { schema };

const connectionString = process.env.DATABASE_URL!;

// Keep hot reloads from creating a new connection pool for every module update.
const globalForDb = globalThis as typeof globalThis & {
  researchDbClient?: ReturnType<typeof postgres>;
  researchSqlClient?: ReturnType<typeof postgres>;
};
const client = globalForDb.researchDbClient ?? postgres(connectionString);
// A long-lived pool for raw queries on hot API paths. Scripts and the worker keep their own clients. It is separate
// from drizzle's pool because drizzle makes its client return timestamps as raw Postgres text instead of Dates.
const rawClient = globalForDb.researchSqlClient ?? postgres(connectionString);
if (process.env.NODE_ENV !== "production") {
  globalForDb.researchDbClient = client;
  globalForDb.researchSqlClient = rawClient;
}
export const db = drizzle(client, { schema });
export const sqlClient = rawClient;
