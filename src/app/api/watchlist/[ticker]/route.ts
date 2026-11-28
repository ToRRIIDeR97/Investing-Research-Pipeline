import { NextRequest } from "next/server";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";

/** DELETE /api/watchlist/:ticker — unstar a stock. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  try {
    const { ticker: raw } = await params;
    let ticker: string;
    try { ticker = decodeURIComponent(raw); } catch { throw new ApiError("The ticker in the address is not valid.", 400, "INVALID_TICKER"); }
    const { pipelineSql } = await import("@/db/pipeline-sql");
    const { removeFromWatchlist } = await import("@/lib/api/watchlist");
    return successResponse({ ticker: ticker.trim().toUpperCase(), removed: await removeFromWatchlist(pipelineSql(), ticker) });
  } catch (error) {
    return handleApiError(error);
  }
}
