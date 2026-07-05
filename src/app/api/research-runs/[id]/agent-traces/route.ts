import { NextRequest } from "next/server";
import { db } from "@/db";
import { agent_traces } from "@/db/schema/ai";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const traces = await db
      .select()
      .from(agent_traces)
      .where(eq(agent_traces.research_run_id, runId))
      .orderBy(desc(agent_traces.created_at));

    return successResponse(traces);
  } catch (error) {
    return handleApiError(error);
  }
}
