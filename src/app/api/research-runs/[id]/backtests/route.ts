import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs, research_tasks } from "@/db/schema/workflow";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq, and, asc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    // Verify the research run exists
    const [run] = await db
      .select({ id: research_runs.id })
      .from(research_runs)
      .where(eq(research_runs.id, runId))
      .limit(1);

    if (!run) {
      throw new ApiError("Research run not found", 404, "NOT_FOUND");
    }

    const tasks = await db
      .select()
      .from(research_tasks)
      .where(
        and(
          eq(research_tasks.research_run_id, runId),
          eq(research_tasks.task_type, "backtest")
        )
      )
      .orderBy(asc(research_tasks.created_at));

    return successResponse(tasks);
  } catch (error) {
    return handleApiError(error);
  }
}
