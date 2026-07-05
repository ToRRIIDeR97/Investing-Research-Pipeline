import { NextRequest } from "next/server";
import { db } from "@/db";
import { model_call_logs } from "@/db/schema/ai";
import { research_runs } from "@/db/schema/workflow";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, sql } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assetId } = await params;

    // Get all research run IDs for this asset
    const runs = await db
      .select({ id: research_runs.id })
      .from(research_runs)
      .where(eq(research_runs.asset_id, assetId));

    if (runs.length === 0) {
      return successResponse([]);
    }

    const runIds = runs.map((r) => r.id);

    // Aggregate cost by model tier across all runs for this asset
    const costByTier = await db
      .select({
        tier: model_call_logs.model_tier,
        cost: sql<string>`coalesce(sum(${model_call_logs.cost_usd}), 0)`,
        calls: sql<string>`count(*)`,
      })
      .from(model_call_logs)
      .where(
        sql`${model_call_logs.research_run_id} = ANY(${runIds})`
      )
      .groupBy(model_call_logs.model_tier);

    const chartData = costByTier.map((row) => ({
      tier: row.tier,
      cost: parseFloat(row.cost),
      calls: parseInt(row.calls, 10),
    }));

    return successResponse(chartData);
  } catch (error) {
    return handleApiError(error);
  }
}
