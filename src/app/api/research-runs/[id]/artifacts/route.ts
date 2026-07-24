import { NextRequest } from "next/server";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { getResearchRunArtifacts } from "@/lib/research/artifacts/read-model";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const artifacts = await getResearchRunArtifacts(runId);
    if (artifacts === null) throw new ApiError("Research run not found", 404, "NOT_FOUND");
    return successResponse({ artifacts });
  } catch (error) {
    return handleApiError(error);
  }
}
