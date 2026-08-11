import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import { approveHumanReview, isApprovedHumanDecision, isKnownHumanDecision } from "@/lib/workflow/orchestrator";
import { enqueueResearchRun, getLatestResearchRunJob } from "@/lib/research/run-queue";
import { reviewDecisionSchema } from "@/lib/api/validation";
import { CURRENT_PIPELINE_VERSION } from "@/lib/research/version";

/**
 * Persist the final human decision before approving the workflow stage.
 * The stage row is locked during the insert so duplicate submissions are
 * idempotent and cannot create two effective transitions.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json();
    const parsed = reviewDecisionSchema.parse({
      status: body.status,
      conviction: body.conviction,
      priority: body.priority,
      watchlist_reason: body.watchlistReason ?? body.watchlist_reason,
      position_sizing_note: body.positionSizingNote ?? body.position_sizing_note,
      what_would_change_mind: body.whatWouldChangeMind ?? body.what_would_change_mind,
      open_questions: body.openQuestions ?? body.open_questions,
      reviewed_by: body.reviewedBy ?? body.reviewed_by ?? "user",
    });
    const status = parsed.status.toLowerCase();
    if (!isKnownHumanDecision(status)) {
      throw new ApiError("Unknown human review decision", 400, "INVALID_REVIEW_STATUS");
    }

    const sql = postgres(process.env.DATABASE_URL!);
    let decision: Record<string, unknown>;
    let inserted = false;
    try {
      const transaction = await sql.begin(async (tx) => {
        const runs = await tx`
          SELECT id, asset_id, pipeline_version, status
          FROM research_runs WHERE id = ${runId} LIMIT 1 FOR UPDATE
        `;
        if (!runs[0]) throw new ApiError("Research run not found", 404, "NOT_FOUND");
        if (Number(runs[0].pipeline_version) !== CURRENT_PIPELINE_VERSION) {
          throw new ApiError("Final review is available only for current v4 runs", 422, "UNSUPPORTED_PIPELINE_VERSION");
        }

        const stages = await tx`
          SELECT id, status FROM research_stages
          WHERE research_run_id = ${runId} AND stage_key = 'human_review'
          LIMIT 1 FOR UPDATE
        `;
        if (!stages[0]) throw new ApiError("Human review stage not found", 404, "NOT_FOUND");

        const existing = await tx`
          SELECT * FROM review_decisions
          WHERE research_run_id = ${runId} AND status = ${status}
          ORDER BY reviewed_at DESC LIMIT 1
        `;
        if (existing[0]) {
          return { decision: existing[0], inserted: false, stageStatus: String(stages[0].status) };
        }
        if (stages[0].status !== "waiting_for_human") {
          throw new ApiError(
            `Human review is not actionable (status: ${stages[0].status})`,
            422,
            "INVALID_REVIEW_STAGE_STATUS"
          );
        }

        const rows = await tx`
          INSERT INTO review_decisions (
            asset_id, research_run_id, status, conviction, priority,
            watchlist_reason, position_sizing_note, what_would_change_mind,
            open_questions, reviewed_by, reviewed_at
          ) VALUES (
            ${runs[0].asset_id}, ${runId}, ${status}, ${parsed.conviction || null},
            ${parsed.priority || null}, ${parsed.watchlist_reason || null},
            ${parsed.position_sizing_note || null}, ${parsed.what_would_change_mind || null},
            ${parsed.open_questions || null}, ${parsed.reviewed_by}, NOW()
          )
          RETURNING *
        `;
        if (!rows[0]) throw new ApiError("Unable to persist human review", 500, "REVIEW_NOT_SAVED");

        if (status === "needs_more_work") {
          await tx`
            UPDATE research_runs
            SET status = 'waiting_for_human',
                failure_reason = ${parsed.open_questions || parsed.watchlist_reason || null},
                metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${tx.json({
                  human_review_notes: parsed.open_questions || parsed.watchlist_reason || "Needs more work",
                  human_review_requested_by: parsed.reviewed_by,
                  human_review_requested_at: new Date().toISOString(),
                })}, updated_at = NOW()
            WHERE id = ${runId}
          `;
        }
        return { decision: rows[0], inserted: true, stageStatus: String(stages[0].status) };
      });
      decision = transaction.decision as Record<string, unknown>;
      inserted = transaction.inserted;
    } finally {
      await sql.end();
    }

    if (status === "needs_more_work") {
      return (inserted ? createdResponse : successResponse)({ decision, workflow: { success: true, status: "needs_more_work" } });
    }

    if (!isApprovedHumanDecision(status)) {
      return (inserted ? createdResponse : successResponse)(decision);
    }

    const approval = await approveHumanReview(runId, parsed.reviewed_by);
    if (!approval.success) {
      // A second identical request may arrive after the first request already
      // approved the stage. Treat that settled state as idempotent.
      const latestJob = await getLatestResearchRunJob(runId);
      if (latestJob?.status === "queued" || latestJob?.status === "running" || latestJob?.status === "completed") {
        return successResponse({ decision, workflow: approval, job: latestJob });
      }
      return successResponse({ decision, workflow: approval }, 422);
    }
    const job = await enqueueResearchRun(runId, parsed.reviewed_by);
    return successResponse({ decision, workflow: approval, jobId: job.id, job }, inserted ? 201 : 200);
  } catch (error) {
    return handleApiError(error);
  }
}
