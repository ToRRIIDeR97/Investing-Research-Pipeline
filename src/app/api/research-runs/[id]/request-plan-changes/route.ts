import { NextRequest } from "next/server";
import { requestResearchPlanChanges } from "@/lib/workflow/orchestrator";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { enqueueResearchRun } from "@/lib/research/run-queue";

/** POST /api/research-runs/:id/request-plan-changes: record the feedback and queue the plan redraft. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json().catch(() => ({}));
    const requestedBy = body.requested_by || body.requestedBy || "user";
    const result = await requestResearchPlanChanges(runId, String(body.notes || ""), requestedBy);
    if (!result.success) return successResponse(result, 422);
    const job = await enqueueResearchRun(runId, requestedBy);
    return successResponse({ ...result, status: "redraft_queued", jobId: job.id });
  } catch (error) {
    return handleApiError(error);
  }
}
