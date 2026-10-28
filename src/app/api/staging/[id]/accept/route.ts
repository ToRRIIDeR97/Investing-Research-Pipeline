import { NextRequest } from "next/server";
import { z } from "zod";
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
    const stagingId = z.string().guid().parse((await params).id);
    const body = (await request.json().catch(() => null)) ?? {};

    if (body.action === "reject") {
      if (!body.reason) {
        throw new ApiError("Rejection reason is required", 400);
      }
      const outcome = await rejectStagedOutput(stagingId, String(body.reason));
      if (outcome === "not_found") throw new ApiError("Staged output not found", 404, "NOT_FOUND");
      if (outcome === "not_rejectable") {
        throw new ApiError("Only a staged output that is not yet accepted or rejected can be rejected", 409, "NOT_REJECTABLE");
      }
      return successResponse({ rejected: true, stagingId });
    }

    const result = await acceptStagedOutput(stagingId);
    if (!result) {
      throw new ApiError("Only a valid staged output that is not yet accepted or rejected can be accepted", 409, "NOT_ACCEPTABLE");
    }
    return successResponse({ accepted: true, recordId: result.recordId, stagingId });
  } catch (error) {
    return handleApiError(error);
  }
}
