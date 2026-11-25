import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";

/**
 * GET /api/quant-finder?q= — the Quant finder's data. Always the recently computed tickers with their grades; with
 * `q`, up to 8 SEC directory matches, each with its newest snapshot when there is one. Read-only, no model calls.
 * When SEC's directory can't be fetched, `results` is empty and `directory` is "unavailable" (the finder still opens
 * any typed ticker). Database failures degrade the same way: no recent list and no grades, but search still works.
 */
export async function GET(request: NextRequest) {
  try {
    const q = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 60);
    const { pipelineSql } = await import("@/db/pipeline-sql");
    const { recentSnapshots, searchDirectory, secDirectory, snapshotsFor } = await import("@/lib/quant/directory");
    const sql = pipelineSql();
    const recent = await recentSnapshots(sql, 8).catch(() => []);
    if (!q.trim()) return successResponse({ recent, results: [], directory: "ok" });
    let directory: "ok" | "unavailable" = "ok";
    let matches: { ticker: string; name: string }[] = [];
    try { matches = searchDirectory(await secDirectory(), q, 8); } catch { directory = "unavailable"; }
    const snaps = await snapshotsFor(sql, matches.map((m) => m.ticker)).catch(() => new Map());
    return successResponse({ recent, results: matches.map((m) => ({ ...m, snapshot: snaps.get(m.ticker) ?? null })), directory });
  } catch (error) {
    return handleApiError(error);
  }
}
