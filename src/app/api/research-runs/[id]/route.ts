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

    // Task metadata only: input and output JSON reach tens of MB per run and the run page polls this route.
    const tasks = await db
      .select({
        id: research_tasks.id,
        stage_id: research_tasks.stage_id,
        task_key: research_tasks.task_key,
        task_type: research_tasks.task_type,
        agent_name: research_tasks.agent_name,
        status: research_tasks.status,
        priority: research_tasks.priority,
        retry_count: research_tasks.retry_count,
        failure_reason: research_tasks.failure_reason,
        started_at: research_tasks.started_at,
        completed_at: research_tasks.completed_at,
        created_at: research_tasks.created_at,
      })
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
