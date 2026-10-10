import { NextRequest } from "next/server";
import { approveRequestReset, RequestResetError } from "@/lib/workflow/orchestrator";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";
import { enqueueResearchRun } from "@/lib/research/run-queue";

/**
 * POST /api/research-runs/:id/request-reset
 * Decide a team-request re-run that exceeded the automatic limit: { decision: "rerun" | "skip", actor? }.
 * Either decision resumes the run, which starts paid work.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json().catch(() => ({}));
    if (body.decision !== "rerun" && body.decision !== "skip") throw new ApiError("decision must be rerun or skip", 400, "INVALID_DECISION");
    const actor = String(body.actor || "user");
    const result = await approveRequestReset(runId, { decision: body.decision, actor }).catch((error) => {
      throw error instanceof RequestResetError ? new ApiError(error.message, 422, "NOT_PAUSED_ON_REQUEST_RESET") : error;
    });
    const job = await enqueueResearchRun(runId, actor);
    return successResponse({ ...result, jobId: job.id, job });
  } catch (error) {
    return handleApiError(error);
  }
}
