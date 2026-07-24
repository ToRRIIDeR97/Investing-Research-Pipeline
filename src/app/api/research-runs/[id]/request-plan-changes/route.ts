import { NextRequest } from "next/server";
import { requestResearchPlanChanges } from "@/lib/workflow/orchestrator";
import { handleApiError, successResponse } from "@/lib/api/errors";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json().catch(() => ({}));
    const result = await requestResearchPlanChanges(
      runId,
      String(body.notes || "Changes requested by reviewer"),
      body.requested_by || body.requestedBy || "user"
    );
    return successResponse(result, result.success ? 200 : 422);
  } catch (error) {
    return handleApiError(error);
  }
}
