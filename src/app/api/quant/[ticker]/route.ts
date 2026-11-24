import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";

/**
 * GET /api/quant/:ticker — the Quant page's PragValue and PragTrend snapshot, cached per ticker and day.
 * `?refresh=1` recomputes. Code only: no model calls, no research artifacts.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ ticker: string }> }) {
  try {
    const { ticker } = await params;
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    const { pipelineSql } = await import("@/db/pipeline-sql");
    const { quantSnapshotFor } = await import("@/lib/api/quant");
    const { snapshot, cached } = await quantSnapshotFor(pipelineSql(), decodeURIComponent(ticker), refresh);
    return successResponse({ ...snapshot, cached });
  } catch (error) {
    return handleApiError(error);
  }
}
