import postgres from "postgres";

let pool: ReturnType<typeof postgres> | undefined;

/**
 * A pool shared by the pipeline's hot paths (stage transitions, validators, quality gates, model-call records),
 * which otherwise opened a client per call. It is created on first use, after scripts have loaded DATABASE_URL.
 * Idle connections close after 2 s, so scripts, tests and `worker --once` still exit on their own. Keep
 * session state off it: no session-level advisory locks, SET or LISTEN, and never wrap it in drizzle().
 */
export function pipelineSql(): ReturnType<typeof postgres> {
  pool ??= postgres(process.env.DATABASE_URL!, { idle_timeout: 2 });
  return pool;
}
