import { NextRequest } from "next/server";
import { advanceStage } from "@/lib/workflow/orchestrator";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";

/**
 * POST /api/research-runs/:id/advance
 * Advance the research workflow to the next stage.
 * §29: advanceResearchStage domain command.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const result = await advanceStage(runId);

    if (!result.success) {
      return successResponse(
        {
          advanced: false,
          action: result.action,
          error: result.error,
          nextStage: result.nextStage,
        },
        422
      );
    }

    return successResponse({
      advanced: true,
      action: result.action,
      nextStage: result.nextStage,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
