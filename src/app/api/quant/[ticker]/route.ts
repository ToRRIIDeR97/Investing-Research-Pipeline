import { NextRequest } from "next/server";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";

/**
 * GET /api/quant/:ticker — the Quant page's PragValue and PragTrend snapshot, cached per ticker and day.
 * `?refresh=1` recomputes (at most every five minutes). Code only: no model calls, no research artifacts.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  try {
    const { ticker: raw } = await params;
    let ticker: string;
    try { ticker = decodeURIComponent(raw); } catch { throw new ApiError("The ticker in the address is not valid.", 400, "INVALID_TICKER"); }
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    const { pipelineSql } = await import("@/db/pipeline-sql");
    const { quantSnapshotFor } = await import("@/lib/api/quant");
    const { snapshot, cached } = await quantSnapshotFor(pipelineSql(), ticker, refresh);
    return successResponse({ ...snapshot, cached });
  } catch (error) {
    return handleApiError(error);
  }
}
