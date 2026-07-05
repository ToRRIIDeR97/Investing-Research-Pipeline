import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs, research_stages } from "@/db/schema/workflow";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assetId } = await params;

    // Get the most recent research run for this asset
    const [latestRun] = await db
      .select({ id: research_runs.id })
      .from(research_runs)
      .where(eq(research_runs.asset_id, assetId))
      .orderBy(desc(research_runs.created_at))
      .limit(1);

    if (!latestRun) {
      return successResponse([]);
    }

    // Get all stages for the latest run
    const stages = await db
      .select({
        stage_key: research_stages.stage_key,
        stage_order: research_stages.stage_order,
        status: research_stages.status,
      })
      .from(research_stages)
      .where(eq(research_stages.research_run_id, latestRun.id))
      .orderBy(research_stages.stage_order);

    return successResponse(stages);
  } catch (error) {
    return handleApiError(error);
  }
}
