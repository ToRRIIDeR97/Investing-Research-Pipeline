import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import { approveHumanReview, isApprovedHumanDecision, isKnownHumanDecision } from "@/lib/workflow/orchestrator";
import { enqueueResearchRun, getLatestResearchRunJob } from "@/lib/research/run-queue";
import { reviewDecisionSchema } from "@/lib/api/validation";
import { CURRENT_PIPELINE_VERSION } from "@/lib/research/version";
import { getReportState, loadReportInputs } from "@/lib/research/reporting/store";
import type { Sql } from "@/lib/research/run-context";

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
    let regenerateReport = false;
    try {
      const transaction = await sql.begin(async (tx) => {
        const runs = await tx`
          SELECT id, asset_id, pipeline_version, status, metadata_json
          FROM research_runs WHERE id = ${runId} LIMIT 1 FOR UPDATE
        `;
        if (!runs[0]) throw new ApiError("Research run not found", 404, "NOT_FOUND");
        if (Number(runs[0].pipeline_version) !== CURRENT_PIPELINE_VERSION) {
          throw new ApiError("Final review is available only for current v3 runs", 422, "UNSUPPORTED_PIPELINE_VERSION");
        }

        const stages = await tx`
          SELECT id, status FROM research_stages
          WHERE research_run_id = ${runId} AND stage_key = 'human_review'
          LIMIT 1 FOR UPDATE
        `;
        if (!stages[0]) throw new ApiError("Human review stage not found", 404, "NOT_FOUND");

        const report = await getReportState(tx as unknown as Sql, runId);
        if (report.required && status === "needs_more_work" && (!report.document || body.reportHash !== report.document.content_hash)) {
          throw new ApiError("Load the current report before requesting a revision.", 409, "STALE_REPORT");
        }
        if (report.required && isApprovedHumanDecision(status)) {
          if (!report.document) throw new ApiError("The research report is not ready for approval", 409, "REPORT_NOT_READY");
          if (body.reportHash !== report.document.content_hash) throw new ApiError("The report changed or was not loaded. Read the current report before approving.", 409, "STALE_REPORT");
          const current = await loadReportInputs(tx as unknown as Sql, runId, report.cutoff);
          if (current.input_hash !== report.document.input_hash) throw new ApiError("Research inputs changed. Regenerate and review the report.", 409, "STALE_REPORT_INPUTS");
          if (!report.review || !["pass", "conditional_pass"].includes(report.review.review_verdict)) throw new ApiError("The report has unresolved review findings. Request more work before approving.", 422, "REPORT_REVIEW_FAILED");
          if (status === "approved_for_position" && report.document.conclusion_status === "withheld") throw new ApiError("Material research gaps prevent position approval. Request more work or approve for tracking.", 422, "RESEARCH_INCOMPLETE");
        }

        const existing = await tx`
          SELECT * FROM review_decisions
          WHERE research_run_id = ${runId} AND status = ${status}
          ORDER BY reviewed_at DESC LIMIT 1
        `;
        const priorRevision = runs[0].metadata_json?.report_revision_request;
        const sameRevisionRequest = status === "needs_more_work" && priorRevision?.report_hash === body.reportHash &&
          priorRevision?.notes === (parsed.open_questions || parsed.watchlist_reason || "Address unresolved review findings") &&
          stages[0].status !== "waiting_for_human";
        if (existing[0] && (!report.required || runs[0].metadata_json?.report_approval?.report_hash === body.reportHash || sameRevisionRequest)) {
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

        if (report.required && isApprovedHumanDecision(status) && report.document) {
          await tx`UPDATE research_runs SET metadata_json = metadata_json || ${tx.json({ report_approval: {
            report_hash: report.document.content_hash, input_hash: report.document.input_hash,
            decision_id: rows[0].id, reviewed_by: parsed.reviewed_by,
          } })} WHERE id = ${runId}`;
        }

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
          if (report.required) {
            await tx`UPDATE research_stages SET status = 'pending', completed_at = NULL, failure_reason = NULL,
              validation_result_json = NULL, updated_at = NOW()
              WHERE research_run_id = ${runId} AND stage_key IN ('ai_reviewer', 'human_review', 'export', 'refresh_schedule')`;
            await tx`UPDATE research_runs SET status = 'running', completed_at = NULL,
              metadata_json = (metadata_json - 'report_approval') || ${tx.json({ report_revision_request: {
                decision_id: rows[0].id, notes: parsed.open_questions || parsed.watchlist_reason || "Address unresolved review findings",
                report_hash: report.document?.content_hash,
              } })} WHERE id = ${runId}`;
          }
        }
        return { decision: rows[0], inserted: true, stageStatus: String(stages[0].status), regenerateReport: report.required && status === "needs_more_work" };
      });
      decision = transaction.decision as Record<string, unknown>;
      inserted = transaction.inserted;
      regenerateReport = "regenerateReport" in transaction && Boolean(transaction.regenerateReport);
    } finally {
      await sql.end();
    }

    if (status === "needs_more_work") {
      if (regenerateReport) {
        const job = await enqueueResearchRun(runId, parsed.reviewed_by);
        return createdResponse({ decision, workflow: { success: true, status: "revision_queued" }, jobId: job.id });
      }
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
