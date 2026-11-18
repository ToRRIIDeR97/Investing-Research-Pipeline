import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schemas";

type Sql = ReturnType<typeof postgres>;
export type PipelineDb = PostgresJsDatabase<typeof schema> & { $client: Sql };

let pool: Sql | undefined;
let drizzlePool: PipelineDb | undefined;

/**
 * The raw pool every pipeline, queue and API path shares instead of opening a client per call. It is created on
 * first use, after scripts have loaded DATABASE_URL. Idle connections close after 2 s, so scripts, tests and
 * `worker --once` still exit on their own without calling end(); nothing should call end() on it. Keep session
 * state off it: no session-level advisory locks, SET or LISTEN (use a transaction, or a reserved connection on a
 * client of your own, as the runner's run lock does), and never wrap it in drizzle(): drizzle replaces its
 * client's timestamp and JSON parsers and serializers, which would change every raw query on the pool.
 */
export function pipelineSql(): Sql {
  pool ??= postgres(process.env.DATABASE_URL!, { idle_timeout: 2 });
  return pool;
}

/**
 * A drizzle client on its own pool, for the artifact repository and other drizzle queries. Its `$client` returns
 * timestamps as Postgres text and passes JSON and timestamp parameters through unserialized (drizzle's own
 * settings), so raw queries belong on pipelineSql(). Created on first use; idle connections close after 2 s.
 */
export function pipelineDb(): PipelineDb {
  drizzlePool ??= drizzle(postgres(process.env.DATABASE_URL!, { idle_timeout: 2 }), { schema }) as PipelineDb;
  return drizzlePool;
}
