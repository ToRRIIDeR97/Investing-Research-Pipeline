import { NextRequest } from "next/server";
import { db } from "@/db";
import { metric_observations, metric_definitions } from "@/db/schema/metrics";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, and, asc } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assetId } = await params;
    const { searchParams } = new URL(request.url);
    const metricKey = searchParams.get("metric_key");

    // Join observations with definitions to get display names
    const rows = await db
      .select({
        period: metric_observations.period_start,
        value: metric_observations.value_numeric,
        unit: metric_observations.unit,
        currency: metric_observations.currency,
        metric_key: metric_definitions.metric_key,
        display_name: metric_definitions.display_name,
        metric_category: metric_definitions.metric_category,
      })
      .from(metric_observations)
      .innerJoin(
        metric_definitions,
        eq(metric_observations.metric_definition_id, metric_definitions.id)
      )
      .where(
        metricKey
          ? and(
              eq(metric_observations.asset_id, assetId),
              eq(metric_definitions.metric_key, metricKey)
            )
          : eq(metric_observations.asset_id, assetId)
      )
      .orderBy(asc(metric_observations.period_start));

    // Transform for chart consumption
    const chartData = rows
      .filter((r) => r.period != null && r.value != null)
      .map((r) => ({
        period: r.period!,
        value: parseFloat(r.value!),
        metric_name: r.display_name,
        metric_key: r.metric_key,
        unit: r.unit,
        currency: r.currency,
        category: r.metric_category,
      }));

    return successResponse(chartData);
  } catch (error) {
    return handleApiError(error);
  }
}
