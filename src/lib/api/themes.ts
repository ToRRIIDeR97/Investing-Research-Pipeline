/**
 * Theme research routes' logic: create (validated request), list, read, and run (claims the row, runs the pipeline,
 * stores the result or a reader-facing error). Global, at most MAX_THEMES rows.
 */
import type { NextRequest } from "next/server";
import { pipelineSql } from "@/db/pipeline-sql";
import { ApiError } from "@/lib/api/errors";
import { ThemeRequest } from "@/lib/research/themes";
import { runThemeResearch, type ThemeDeps } from "@/lib/research/themes/pipeline";

export const MAX_THEMES = 200;
export const MAX_THEME_BODY_BYTES = 16_384;
/** A run marked running for longer than this is treated as abandoned and may be started again. */
const STALE_RUN_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const themeModelCallsEnabled = () => process.env.RUN_PAID_RESEARCH === "1" || process.env.RESEARCH_MODEL_PROVIDER === "mock";

export function themeId(id: string) {
  if (!UUID.test(id)) throw new ApiError("Theme not found", 404, "NOT_FOUND");
  return id;
}

/** Refuses a write whose Origin names another origin, as the chat does. */
export function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== `${request.nextUrl.protocol}//${request.headers.get("host")}`) throw new ApiError("Cross-origin requests are not allowed.", 403);
}

export async function readThemeBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_THEME_BODY_BYTES) throw new ApiError("Request body is too large", 413, "BODY_TOO_LARGE");
  try { return JSON.parse(text); } catch { throw new ApiError("Request body must be JSON", 400, "INVALID_JSON"); }
}

const iso = (v: unknown) => v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null;
type Row = Record<string, any>;
const summary = (r: Row) => ({ id: String(r.id), theme: String(r.theme), request: r.request_json, status: String(r.status),
  error: r.error ?? null, cost_usd: Number(r.cost_usd ?? 0), created_at: iso(r.created_at), started_at: iso(r.started_at), completed_at: iso(r.completed_at) });
/** A theme with its full result. */
const toTheme = (r: Row) => ({ ...summary(r), result: r.result_json ?? null });
/** A theme in the list: its shortlist only. */
const toListed = (r: Row) => ({ ...summary(r), shortlist: Array.isArray(r.result_json?.shortlist) ? r.result_json.shortlist : [] });

export async function createTheme(body: unknown) {
  const request = ThemeRequest.parse(body);
  const sql = pipelineSql();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM theme_research`;
  if (n >= MAX_THEMES) throw new ApiError(`At most ${MAX_THEMES} themes are kept. Delete old ones first.`, 409, "TOO_MANY_THEMES");
  const [row] = await sql`INSERT INTO theme_research (theme, request_json) VALUES (${request.theme}, ${sql.json(request as never)}) RETURNING *`;
  return toTheme(row);
}

export async function listThemes() {
  // The list carries each theme's shortlist, not its whole result.
  const rows = await pipelineSql()`SELECT id, theme, request_json, status, error, cost_usd, created_at, started_at, completed_at,
      jsonb_build_object('shortlist', result_json->'shortlist') AS result_json FROM theme_research ORDER BY created_at DESC LIMIT ${MAX_THEMES}`;
  return rows.map(toListed);
}

export async function getTheme(id: string) {
  const [row] = await pipelineSql()`SELECT * FROM theme_research WHERE id = ${themeId(id)}`;
  if (!row) throw new ApiError("Theme not found", 404, "NOT_FOUND");
  return toTheme(row);
}

/** Runs the pipeline for one theme: 409 while it is running, a stored result on success, a stored reader-facing error on failure. */
export async function runTheme(id: string, deps: ThemeDeps = {}) {
  themeId(id);
  if (!themeModelCallsEnabled()) throw new ApiError("Theme research makes model calls, which are off for this workspace. Enable paid research with a budget, or use the mock provider for testing.", 503);
  const sql = pipelineSql();
  const [claimed] = await sql`UPDATE theme_research SET status = 'running', started_at = NOW(), updated_at = NOW(), error = NULL
    WHERE id = ${id} AND (status <> 'running' OR started_at < NOW() - ${`${STALE_RUN_MS / 1000} seconds`}::interval) RETURNING *`;
  if (!claimed) {
    const [exists] = await sql`SELECT status FROM theme_research WHERE id = ${id}`;
    if (!exists) throw new ApiError("Theme not found", 404, "NOT_FOUND");
    throw new ApiError("This theme is already being researched. Wait for it to finish.", 409, "ALREADY_RUNNING");
  }
  const request = ThemeRequest.parse(claimed.request_json);
  try {
    const { result, cost_usd } = await runThemeResearch(id, request, deps);
    const [row] = await sql`UPDATE theme_research SET status = 'completed', result_json = ${sql.json(result as never)}, cost_usd = ${cost_usd},
      completed_at = NOW(), updated_at = NOW() WHERE id = ${id} RETURNING *`;
    return toTheme(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [row] = await sql`UPDATE theme_research SET status = 'failed', error = ${`Theme research failed: ${message}`.slice(0, 500)},
      completed_at = NOW(), updated_at = NOW() WHERE id = ${id} RETURNING *`;
    return toTheme(row);
  }
}
