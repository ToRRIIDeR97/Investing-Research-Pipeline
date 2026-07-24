import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { getWorkerHealth, listResearchRunJobs } from "@/lib/research/run-queue";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const [jobs, workers] = await Promise.all([
      listResearchRunJobs(runId),
      getWorkerHealth(),
    ]);
    return successResponse({ jobs, latestJob: jobs[0] || null, workers });
  } catch (error) {
    return handleApiError(error);
  }
}
