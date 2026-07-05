import { NextRequest } from "next/server";
import { db } from "@/db";
import { metric_observations } from "@/db/schema/metrics";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const observations = await db
      .select()
      .from(metric_observations)
      .where(eq(metric_observations.research_run_id, runId))
      .orderBy(desc(metric_observations.created_at));

    return successResponse(observations);
  } catch (error) {
    return handleApiError(error);
  }
}
