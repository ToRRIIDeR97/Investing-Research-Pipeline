import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs } from "@/db/schema/workflow";
import { handleApiError, createdResponse, ApiError } from "@/lib/api/errors";
import { eq } from "drizzle-orm";
import { createResearchRunWithStages } from "@/lib/research/run-service";

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
    const newRun = await createResearchRunWithStages({
      assetId: originalRun.asset_id,
      runType: run_type,
      researchQuestion: originalRun.research_question,
      requestedBy: "refresh",
      profileId: originalRun.profile_id,
      profileVersion: originalRun.profile_version,
      budgetLimitUsd: originalRun.budget_limit_usd ? Number(originalRun.budget_limit_usd) : null,
      sourceCutoffAt: source_cutoff_at ? new Date(source_cutoff_at) : null,
      marketDataCutoffAt: market_data_cutoff_at ? new Date(market_data_cutoff_at) : null,
    });

    return createdResponse(newRun);
  } catch (error) {
    return handleApiError(error);
  }
}
