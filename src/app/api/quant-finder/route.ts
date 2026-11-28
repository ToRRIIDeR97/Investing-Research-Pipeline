import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";

/**
 * GET /api/quant-finder?q= — the Quant finder's data. Always the recently computed tickers with their grades; with
 * `q`, up to 8 SEC directory matches plus Yahoo Finance's non-US listings (BBCA.JK for "BBCA" or "Bank Central Asia"),
 * each with its newest snapshot when there is one. Read-only, no model calls. When SEC's directory can't be fetched,
 * `directory` is "unavailable" (Yahoo results and any typed ticker still work). Database failures degrade the same
 * way: no recent list and no grades, but search still works.
 */
export async function GET(request: NextRequest) {
  try {
    const q = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 60);
    const { pipelineSql } = await import("@/db/pipeline-sql");
    const { mergeFinderMatches, recentSnapshots, searchDirectory, secDirectory, snapshotsFor } = await import("@/lib/quant/directory");
    const { searchListedCompanies } = await import("@/lib/market-data/company-search");
    const sql = pipelineSql();
    const recent = await recentSnapshots(sql, 8).catch(() => []);
    if (!q.trim()) return successResponse({ recent, results: [], directory: "ok" });
    let directory: "ok" | "unavailable" = "ok";
    let listings = "ok";
    const [sec, yahoo] = await Promise.all([
      secDirectory().then((entries) => searchDirectory(entries, q, 8)).catch(() => { directory = "unavailable"; return []; }),
      searchListedCompanies(q, fetch, { international: true, withQuotes: false }).catch((error) => { listings = `unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200); return []; }),
    ]);
    const matches = mergeFinderMatches(q, sec, yahoo, 10);
    const snaps = await snapshotsFor(sql, matches.map((m) => m.ticker)).catch(() => new Map());
    return successResponse({ recent, results: matches.map((m) => ({ ...m, snapshot: snaps.get(m.ticker) ?? null })), directory, listings });
  } catch (error) {
    return handleApiError(error);
  }
}
