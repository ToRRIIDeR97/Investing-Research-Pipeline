import { NextRequest } from "next/server";
import { ApiError, createdResponse, handleApiError, successResponse } from "@/lib/api/errors";

/** GET /api/watchlist — starred stocks, newest first, each with its newest Quant snapshot summary. */
export async function GET() {
  try {
    const { pipelineSql } = await import("@/db/pipeline-sql");
    const { listWatchlist } = await import("@/lib/api/watchlist");
    return successResponse(await listWatchlist(pipelineSql()));
  } catch (error) {
    return handleApiError(error);
  }
}

/** POST /api/watchlist { ticker, name?, asset_id? } — star a stock (idempotent). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const { pipelineSql } = await import("@/db/pipeline-sql");
    const { addToWatchlist } = await import("@/lib/api/watchlist");
    const item = await addToWatchlist(pipelineSql(), body ?? {});
    if (!item) throw new ApiError("Give a ticker symbol: a letter, then up to nine letters, digits, dots or dashes.", 400, "INVALID_TICKER");
    return createdResponse(item);
  } catch (error) {
    return handleApiError(error);
  }
}
