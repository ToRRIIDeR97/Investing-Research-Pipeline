import { NextRequest } from "next/server";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { getResearchRunReport } from "@/lib/research/artifacts/read-model";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const report = await getResearchRunReport(runId);
    if (!report) throw new ApiError("Research run not found", 404, "NOT_FOUND");
    return successResponse(report);
  } catch (error) {
    return handleApiError(error);
  }
}
