import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_stages } from "@/db/schema/workflow";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, asc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const stages = await db
      .select()
      .from(research_stages)
      .where(eq(research_stages.research_run_id, runId))
      .orderBy(asc(research_stages.stage_order));

    return successResponse(stages);
  } catch (error) {
    return handleApiError(error);
  }
}
