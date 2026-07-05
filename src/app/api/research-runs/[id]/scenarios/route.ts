import { NextRequest } from "next/server";
import { db } from "@/db";
import { scenarios } from "@/db/schema/valuation";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const results = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.research_run_id, runId))
      .orderBy(desc(scenarios.created_at));

    return successResponse(results);
  } catch (error) {
    return handleApiError(error);
  }
}
