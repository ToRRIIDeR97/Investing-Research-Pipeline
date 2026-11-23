import { pipelineSql } from "@/db/pipeline-sql";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { loadReviewQueue } from "@/lib/review/review-queue";

/**
 * GET /api/review/queue
 * Runs waiting for the final human review, newest first. Older waiting runs of a company carry `replaced_by`
 * (the newer run); the newest run of each company carries `summary` (value against price and the AI review).
 */
export async function GET() {
  try {
    return successResponse(await loadReviewQueue(pipelineSql()));
  } catch (error) {
    return handleApiError(error);
  }
}
