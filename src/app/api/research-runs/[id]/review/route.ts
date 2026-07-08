import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import { approveHumanReview } from "@/lib/workflow/orchestrator";

/**
 * POST /api/research-runs/:id/review
 * Create a review decision for a research run.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json();
    const sql = postgres(process.env.DATABASE_URL!);

    try {
      // Get the run to verify it exists and get asset_id
      const runs = await sql`
        SELECT * FROM research_runs WHERE id = ${runId}
      `;
      if (runs.length === 0) {
        throw new ApiError("Research run not found", 404);
      }

      const run = runs[0];

      const rows = await sql`
        INSERT INTO review_decisions (
          asset_id, research_run_id, status,
          conviction, priority, watchlist_reason,
          position_sizing_note, what_would_change_mind,
          open_questions, reviewed_by, reviewed_at
        ) VALUES (
          ${body.assetId || run.asset_id},
          ${runId},
          ${body.status},
          ${body.conviction || null},
          ${body.priority || null},
          ${body.watchlistReason || null},
          ${body.positionSizingNote || null},
          ${body.whatWouldChangeMind || null},
          ${body.openQuestions || null},
          ${body.reviewedBy || "user"},
          NOW()
        )
        RETURNING *
      `;

      const humanReviewStage = await sql`
        SELECT status FROM research_stages
        WHERE research_run_id = ${runId}
          AND stage_key = 'human_review'
        LIMIT 1
      `;

      // Update run status if needed
      if (body.status === "needs_more_work") {
        await sql`
          UPDATE research_runs SET status = 'waiting_for_human' WHERE id = ${runId}
        `;
      } else if (
        body.status.startsWith("approved") &&
        humanReviewStage[0]?.status === "waiting_for_human"
      ) {
        const approval = await approveHumanReview(runId, body.reviewedBy || "user");
        return createdResponse({ ...rows[0], workflow: approval });
      } else if (body.status.startsWith("approved")) {
        await sql`
          UPDATE research_runs SET status = 'completed' WHERE id = ${runId}
        `;
      }

      return createdResponse(rows[0]);
    } finally {
      await sql.end();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
