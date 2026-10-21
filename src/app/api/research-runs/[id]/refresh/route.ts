import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { research_runs } from "@/db/schema/workflow";
import { handleApiError, createdResponse, ApiError } from "@/lib/api/errors";
import { createResearchRunSchema } from "@/lib/api/validation";
import { eq } from "drizzle-orm";
import { createResearchRunWithStages } from "@/lib/research/run-service";
import { PriorRunError } from "@/lib/research/lineage/runs";

const refreshSchema = z.object({
  run_type: createResearchRunSchema.shape.run_type.optional(),
  source_cutoff_at: z.string().datetime().optional(),
  market_data_cutoff_at: z.string().datetime().optional(),
});

/**
 * Refresh a run: a new run of the same asset and, by default, the same run type, linked to the original
 * through prior_run_id so it starts from the original's prior_research and reports what changed.
 * It is created pending; queuing it (and spending money) stays a separate, explicit request.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const [originalRun] = await db
      .select()
      .from(research_runs)
      .where(eq(research_runs.id, runId))
      .limit(1);

    if (!originalRun) {
      throw new ApiError("Research run not found", 404, "NOT_FOUND");
    }

    const body = refreshSchema.parse(await request.json().catch(() => ({})));
    const runType = body.run_type ?? createResearchRunSchema.shape.run_type.safeParse(originalRun.run_type).data;
    if (!runType) throw new ApiError(`Run type ${originalRun.run_type} can no longer be created; pass run_type`, 422, "UNSUPPORTED_RUN_TYPE");

    const newRun = await createResearchRunWithStages({
      assetId: originalRun.asset_id,
      runType,
      researchQuestion: originalRun.research_question,
      requestedBy: "refresh",
      profileId: originalRun.profile_id,
      profileVersion: originalRun.profile_version,
      budgetLimitUsd: originalRun.budget_limit_usd ? Number(originalRun.budget_limit_usd) : null,
      sourceCutoffAt: body.source_cutoff_at ? new Date(body.source_cutoff_at) : null,
      marketDataCutoffAt: body.market_data_cutoff_at ? new Date(body.market_data_cutoff_at) : null,
      priorRunId: originalRun.id,
    });

    return createdResponse(newRun);
  } catch (error) {
    if (error instanceof PriorRunError) return handleApiError(new ApiError(error.message, 422, error.code));
    return handleApiError(error);
  }
}
