import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import { approveHumanReview, isApprovedHumanDecision, isKnownHumanDecision } from "@/lib/workflow/orchestrator";
import { evaluateResearchQuality } from "@/lib/workflow/quality-gates";

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
      const status = String(body.status || "").toLowerCase();
      if (!isKnownHumanDecision(status)) {
        throw new ApiError("Review status must be reject, watchlist, needs_more_work, approved_for_tracking, approved_for_position, or archived", 400);
      }

      const rows = await sql`
        INSERT INTO review_decisions (
          asset_id, research_run_id, status,
          conviction, priority, watchlist_reason,
          position_sizing_note, what_would_change_mind,
          open_questions, reviewed_by, reviewed_at
        ) VALUES (
          ${body.assetId || run.asset_id},
          ${runId},
          ${status},
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
      if (status === "needs_more_work") {
        await sql`
          UPDATE research_runs SET status = 'waiting_for_human' WHERE id = ${runId}
        `;
      } else if (
        isApprovedHumanDecision(status) &&
        humanReviewStage[0]?.status === "waiting_for_human"
      ) {
        const approval = await approveHumanReview(runId, body.reviewedBy || "user");
        return createdResponse({ ...rows[0], workflow: approval });
      } else if (isApprovedHumanDecision(status)) {
        const quality = await evaluateResearchQuality(runId);
        await sql`
          UPDATE research_runs
          SET status = ${quality.status === "pass" ? "completed" : "needs_more_work"},
              metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${sql.json({ quality_gate: quality as any })},
              updated_at = NOW()
          WHERE id = ${runId}
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
