import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { CURRENT_PIPELINE_VERSION } from "@/lib/research/version";

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
          rd.reviewed_at,
          rr.pipeline_version,
          hs.status as human_review_status
        FROM research_runs rr
        JOIN assets a ON rr.asset_id = a.id
        LEFT JOIN review_decisions rd ON rd.research_run_id = rr.id
        JOIN research_stages hs
          ON hs.research_run_id = rr.id
         AND hs.stage_key = 'human_review'
         AND hs.status = 'waiting_for_human'
        WHERE rr.pipeline_version = ${CURRENT_PIPELINE_VERSION}
          AND rr.status = 'waiting_for_human'
          AND NOT EXISTS (
            SELECT 1 FROM review_decisions approved
            WHERE approved.research_run_id = rr.id
              AND approved.status IN ('approved_for_tracking', 'approved_for_position')
          )
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
