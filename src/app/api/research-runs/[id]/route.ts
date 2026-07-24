import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs, research_stages, research_tasks } from "@/db/schema/workflow";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq, asc } from "drizzle-orm";
import { getLatestResearchRunJob, getWorkerHealth } from "@/lib/research/run-queue";
import { source_role_coverage } from "@/db/schema/source-intelligence";

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

    const [latestJob, workers, roleCoverage] = await Promise.all([
      getLatestResearchRunJob(id),
      getWorkerHealth(),
      db.select().from(source_role_coverage).where(eq(source_role_coverage.research_run_id, id)),
    ]);

    return successResponse({
      ...run,
      stages,
      tasks,
      latest_job: latestJob,
      worker_health: {
        healthy: workers.some((worker) => worker.status === "healthy" && !worker.stale),
        workers,
      },
      source_role_coverage: roleCoverage,
      source_role_count: new Set(roleCoverage.map((coverage) => coverage.source_role)).size,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
