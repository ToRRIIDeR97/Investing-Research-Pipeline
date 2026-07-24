import { NextRequest } from "next/server";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { getResearchRunArtifacts } from "@/lib/research/artifacts/read-model";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; artifactType: string }> }
) {
  try {
    const { id: runId, artifactType } = await params;
    const artifacts = await getResearchRunArtifacts(runId, artifactType);
    if (artifacts === null) throw new ApiError("Research run not found", 404, "NOT_FOUND");
    if (artifacts.length === 0) throw new ApiError("Artifact not found", 404, "NOT_FOUND");
    return successResponse({ artifact: artifacts[0], artifacts });
  } catch (error) {
    return handleApiError(error);
  }
}
