import { NextRequest } from "next/server";
import { db } from "@/db";
import { valuation_signals } from "@/db/schema/valuation";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assetId } = await params;

    const signals = await db
      .select({
        id: valuation_signals.id,
        signal_name: valuation_signals.signal_name,
        signal: valuation_signals.signal,
        cheapness_score: valuation_signals.cheapness_score,
        current_value: valuation_signals.current_value,
        percentile: valuation_signals.percentile,
        z_score: valuation_signals.z_score,
        lens_family: valuation_signals.lens_family,
        confidence: valuation_signals.confidence,
        review_status: valuation_signals.review_status,
        created_at: valuation_signals.created_at,
      })
      .from(valuation_signals)
      .where(eq(valuation_signals.asset_id, assetId))
      .orderBy(desc(valuation_signals.created_at));

    // Transform for chart consumption
    const chartData = signals.map((s) => ({
      signal_name: s.signal_name,
      signal: s.signal,
      cheapness_score: s.cheapness_score != null ? parseFloat(s.cheapness_score) : null,
      current_value: s.current_value != null ? parseFloat(s.current_value) : null,
      percentile: s.percentile != null ? parseFloat(s.percentile) : null,
      z_score: s.z_score != null ? parseFloat(s.z_score) : null,
      lens_family: s.lens_family,
      confidence: s.confidence != null ? parseFloat(s.confidence) : null,
      review_status: s.review_status,
    }));

    return successResponse(chartData);
  } catch (error) {
    return handleApiError(error);
  }
}
