import { NextRequest } from "next/server";
import { acceptStagedOutput, rejectStagedOutput } from "@/lib/agents/staging";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";

/**
 * POST /api/staging/:id/accept
 * Accept a staged agent output and promote it to the final table.
 * §29: acceptStagedOutput domain command.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: stagingId } = await params;
    const body = await request.json().catch(() => ({}));

    if (body.action === "reject") {
      if (!body.reason) {
        throw new ApiError("Rejection reason is required", 400);
      }
      await rejectStagedOutput(stagingId, body.reason);
      return successResponse({ rejected: true, stagingId });
    }

    const result = await acceptStagedOutput(stagingId);
    return successResponse({ accepted: true, recordId: result.recordId, stagingId });
  } catch (error) {
    return handleApiError(error);
  }
}
