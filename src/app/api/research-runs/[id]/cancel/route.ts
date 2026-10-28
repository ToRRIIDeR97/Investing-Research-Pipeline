import { NextRequest } from "next/server";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";
import { cancelRun } from "@/lib/workflow/orchestrator";

/**
 * POST /api/research-runs/:id/cancel  { actor? }
 * Cancel a run that has not completed. Cancelled is terminal: the run cannot be queued again. A worker running it
 * aborts its in-flight model call within about 10 seconds, when its lease renewal finds the job closed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    // Compared with the Host header, as src/proxy.ts and the chat route do: NextURL rewrites 127.0.0.1 to
    // localhost, so nextUrl.origin refused the app's own http://127.0.0.1 origin (#123).
    const origin = request.headers.get("origin");
    if (origin && origin !== `${request.nextUrl.protocol}//${request.headers.get("host")}`) throw new ApiError("Cross-origin requests are not allowed", 403, "FORBIDDEN");
    const body = await request.json().catch(() => ({}));
    const result = await cancelRun(runId, String(body.actor || "user"));
    if (!result) throw new ApiError("Research run not found", 404, "NOT_FOUND");
    if (!result.cancelled) throw new ApiError(`Run cannot be cancelled from status ${result.status}`, 422, "INVALID_RUN_STATUS");
    return successResponse({ runId, ...result });
  } catch (error) {
    return handleApiError(error);
  }
}
