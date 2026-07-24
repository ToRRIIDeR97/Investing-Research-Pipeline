import { NextRequest } from "next/server";
import { approveResearchPlan, requestResearchPlanChanges } from "@/lib/workflow/orchestrator";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { enqueueResearchRun } from "@/lib/research/run-queue";

/**
 * POST /api/research-runs/:id/approve-plan
 * Approve the research plan human gate and resume the workflow.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json().catch(() => ({}));
    if (body.action === "request_changes") {
      const result = await requestResearchPlanChanges(
        runId,
        String(body.notes || "Changes requested by reviewer"),
        body.requested_by || body.requestedBy || "user"
      );
      return successResponse(result, result.success ? 200 : 422);
    }
    const result = await approveResearchPlan(runId, body.approved_by || "user");
    if (result.success) {
      const job = await enqueueResearchRun(runId, body.approved_by || "user");
      return successResponse({ ...result, jobId: job.id, job });
    }

    return successResponse(result, result.success ? 200 : 422);
  } catch (error) {
    return handleApiError(error);
  }
}
