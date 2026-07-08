import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { runSystemResearchPipeline } from "@/lib/research/system-pipeline";

/**
 * POST /api/research-runs/:id/run-system-pipeline
 * Execute the Research OS system-owned agent pipeline for a run.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const result = await runSystemResearchPipeline(runId);
    return successResponse(result);
  } catch (error) {
    return handleApiError(error);
  }
}
