import { NextRequest } from "next/server";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { getResearchRunArtifacts } from "@/lib/research/artifacts/read-model";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    // ?type= limits the response to one artifact type, so a caller need not download every body.
    const artifacts = await getResearchRunArtifacts(runId, request.nextUrl.searchParams.get("type") || undefined);
    if (artifacts === null) throw new ApiError("Research run not found", 404, "NOT_FOUND");
    return successResponse({ artifacts });
  } catch (error) {
    return handleApiError(error);
  }
}
