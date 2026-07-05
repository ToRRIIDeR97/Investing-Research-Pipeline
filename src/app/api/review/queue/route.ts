import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse } from "@/lib/api/errors";

/**
 * GET /api/review/queue
 * Returns the review queue — runs pending human review.
 */
export async function GET(request: NextRequest) {
  try {
    const sql = postgres(process.env.DATABASE_URL!);

    try {
      const runs = await sql`
        SELECT
          rr.id as run_id,
          rr.asset_id,
          rr.run_type,
          rr.status as run_status,
          rr.research_question,
          rr.completed_at,
          a.canonical_name as asset_name,
          a.slug as asset_slug,
          a.asset_kind,
          rd.id as review_id,
          rd.status as review_status,
          rd.conviction,
          rd.priority,
          rd.reviewed_at
        FROM research_runs rr
        JOIN assets a ON rr.asset_id = a.id
        LEFT JOIN review_decisions rd ON rd.research_run_id = rr.id
        WHERE rr.status IN ('completed', 'waiting_for_human')
        ORDER BY
          CASE WHEN rd.id IS NULL THEN 0 ELSE 1 END,
          rr.completed_at DESC NULLS LAST,
          rr.created_at DESC
        LIMIT 50
      `;

      return successResponse(runs);
    } finally {
      await sql.end();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
