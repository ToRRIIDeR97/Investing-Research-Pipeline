import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs, research_stages } from "@/db/schema/workflow";
import { handleApiError, createdResponse, ApiError } from "@/lib/api/errors";
import { eq } from "drizzle-orm";
import { getApplicableStages } from "@/lib/workflow/stages";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    // Fetch the original research run
    const [originalRun] = await db
      .select()
      .from(research_runs)
      .where(eq(research_runs.id, runId))
      .limit(1);

    if (!originalRun) {
      throw new ApiError("Research run not found", 404, "NOT_FOUND");
    }

    const body = await request.json();
    const {
      run_type = "valuation_refresh",
      source_cutoff_at,
      market_data_cutoff_at,
    } = body as {
      run_type?: string;
      source_cutoff_at?: string;
      market_data_cutoff_at?: string;
    };

    // Create a new research run, copying asset_id from the original
    const [newRun] = await db
      .insert(research_runs)
      .values({
        asset_id: originalRun.asset_id,
        run_type,
        source_cutoff_at: source_cutoff_at ? new Date(source_cutoff_at) : null,
        market_data_cutoff_at: market_data_cutoff_at
          ? new Date(market_data_cutoff_at)
          : null,
      })
      .returning();

    // Create stages for the new run based on the run type
    const applicableStages = getApplicableStages(run_type);
    const stageValues = applicableStages.map((stage) => ({
      research_run_id: newRun.id,
      stage_key: stage.key,
      stage_order: stage.order,
      allowed_model_tiers: stage.allowedModelTiers,
      max_retries: stage.maxRetries,
      completion_criteria_json: {
        requiredOutputs: stage.requiredOutputs,
        requiresHumanApproval: stage.requiresHumanApproval,
      },
    }));

    await db.insert(research_stages).values(stageValues);

    return createdResponse(newRun);
  } catch (error) {
    return handleApiError(error);
  }
}
