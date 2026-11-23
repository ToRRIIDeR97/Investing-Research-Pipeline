import { NextRequest } from "next/server";
import { pipelineSql } from "@/db/pipeline-sql";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { loadReviewQueue } from "@/lib/review/review-queue";

/**
 * GET /api/review/queue
 * Runs waiting for the final human review, newest first. Older waiting runs of a company carry `replaced_by`
 * (the newer run); the newest run of each company carries `summary` (value against price, the AI review and the
 * report's conclusion status). `?summary=0` skips the summaries (every `summary` is null): one query, for the nav
 * badge, Home and the Research list.
 */
export async function GET(request: NextRequest) {
  try {
    const summaries = request.nextUrl.searchParams.get("summary") !== "0";
    return successResponse(await loadReviewQueue(pipelineSql(), { summaries }));
  } catch (error) {
    return handleApiError(error);
  }
}
