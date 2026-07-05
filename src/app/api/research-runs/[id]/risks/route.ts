import { NextRequest } from "next/server";
import { db } from "@/db";
import { risks } from "@/db/schema/thesis";
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
      .from(risks)
      .where(eq(risks.research_run_id, runId))
      .orderBy(desc(risks.created_at));

    return successResponse(results);
  } catch (error) {
    return handleApiError(error);
  }
}
