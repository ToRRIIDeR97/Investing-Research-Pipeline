import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs, research_stages, research_tasks } from "@/db/schema/workflow";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq, asc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const [run] = await db
      .select()
      .from(research_runs)
      .where(eq(research_runs.id, id))
      .limit(1);

    if (!run) {
      throw new ApiError("Research run not found", 404, "NOT_FOUND");
    }

    const stages = await db
      .select()
      .from(research_stages)
      .where(eq(research_stages.research_run_id, id))
      .orderBy(asc(research_stages.stage_order));

    const tasks = await db
      .select()
      .from(research_tasks)
      .where(eq(research_tasks.research_run_id, id))
      .orderBy(asc(research_tasks.created_at));

    return successResponse({
      ...run,
      stages,
      tasks,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
