import { NextRequest } from "next/server";
import { approveResearchPlan } from "@/lib/workflow/orchestrator";
import { handleApiError, successResponse } from "@/lib/api/errors";

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
    const result = await approveResearchPlan(runId, body.approved_by || "user");

    return successResponse(result, result.success ? 200 : 422);
  } catch (error) {
    return handleApiError(error);
  }
}
