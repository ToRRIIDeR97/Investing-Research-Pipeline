import { NextRequest } from "next/server";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { getResearchRunReport } from "@/lib/research/artifacts/read-model";
import { sqlClient } from "@/db";

// `?summary=1` returns the report without large artifact bodies; see getResearchRunReport.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const summary = request.nextUrl.searchParams.get("summary") === "1";
    const report = await getResearchRunReport(runId, sqlClient, { summary });
    if (!report) throw new ApiError("Research run not found", 404, "NOT_FOUND");
    return successResponse(report);
  } catch (error) {
    return handleApiError(error);
  }
}
