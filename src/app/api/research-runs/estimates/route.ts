import { pipelineSql } from "@/db/pipeline-sql";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { runEstimates, type EstimateRow } from "@/lib/research/run-flow";
import { CURRENT_PIPELINE_VERSION } from "@/lib/research/version";

export const dynamic = "force-dynamic";

/**
 * GET /api/research-runs/estimates
 * Typical cost and machine time by run type, from the 200 newest current-pipeline runs that reached the report review
 * (`runEstimates`: medians, the wait at the plan gate left out). Read-only; the start form shows it on each run type.
 */
export async function GET() {
  try {
    const sql = pipelineSql();
    const rows = await sql<EstimateRow[]>`
      SELECT r.run_type, r.actual_cost_usd, r.created_at,
        plan.started_at AS plan_started_at, plan.completed_at AS plan_completed_at, review.completed_at AS review_completed_at
      FROM research_runs r
      JOIN research_stages plan ON plan.research_run_id = r.id AND plan.stage_key = 'research_plan'
      JOIN research_stages review ON review.research_run_id = r.id AND review.stage_key = 'ai_reviewer' AND review.status = 'completed'
      WHERE r.pipeline_version = ${CURRENT_PIPELINE_VERSION}
      ORDER BY r.created_at DESC
      LIMIT 200`;
    return successResponse(runEstimates(rows));
  } catch (error) {
    return handleApiError(error);
  }
}
