import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { enqueueResearchRun } from "@/lib/research/run-queue";

/**
 * POST /api/research-runs/:id/run-system-pipeline
 * Execute the Research OS system-owned agent pipeline for a run.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json().catch(() => ({}));
    const job = await enqueueResearchRun(runId, body.requested_by || body.requestedBy || "user");
    return successResponse(
      {
        runId,
        queued: true,
        jobId: job.id,
        job,
      },
      202
    );
  } catch (error) {
    return handleApiError(error);
  }
}
