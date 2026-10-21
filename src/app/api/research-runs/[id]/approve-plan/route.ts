import { NextRequest } from "next/server";
import { approveResearchPlan } from "@/lib/workflow/orchestrator";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { enqueueResearchRun } from "@/lib/research/run-queue";

/**
 * POST /api/research-runs/:id/approve-plan
 * Approve the research plan human gate and resume the workflow. Optional `framing`, `archetypes`, `overlays` and
 * `forecast_years` are the reviewer's edits: they are validated, saved as the next plan version and approved in the
 * same step. Edits for a plan that is already approved get 409.
 * Plan feedback that needs a redraft goes to POST …/request-plan-changes.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json().catch(() => ({}));
    const approvedBy = body.approved_by || "user";
    const forecastYears = body.forecast_years === undefined || body.forecast_years === null ? undefined : Number(body.forecast_years);
    const result = await approveResearchPlan(runId, approvedBy, { framing: body.framing, archetypes: body.archetypes, overlays: body.overlays, forecastYears });
    if (result.success) {
      const job = await enqueueResearchRun(runId, approvedBy);
      return successResponse({ ...result, jobId: job.id, job });
    }
    // Edits sent after the plan was approved are refused, and no job is queued for them.
    return successResponse(result, result.alreadyApproved ? 409 : 422);
  } catch (error) {
    return handleApiError(error);
  }
}
