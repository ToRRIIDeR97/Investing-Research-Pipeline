import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs, research_tasks, research_stages } from "@/db/schema/workflow";
import { handleApiError, createdResponse, ApiError } from "@/lib/api/errors";
import { eq } from "drizzle-orm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    // Verify the research run exists and is in a valid state
    const [run] = await db
      .select({ id: research_runs.id, status: research_runs.status })
      .from(research_runs)
      .where(eq(research_runs.id, runId))
      .limit(1);

    if (!run) {
      throw new ApiError("Research run not found", 404, "NOT_FOUND");
    }

    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new ApiError(
        `Cannot enqueue tasks for a run in '${run.status}' state`,
        400,
        "INVALID_RUN_STATE"
      );
    }

    const body = await request.json();
    const { task_key, task_type, agent_name, input_json, priority, stage_id } = body as {
      task_key?: string;
      task_type?: string;
      agent_name?: string;
      input_json?: Record<string, unknown>;
      priority?: number;
      stage_id?: string;
    };

    if (!task_key || !task_type) {
      throw new ApiError("task_key and task_type are required", 400, "VALIDATION_ERROR");
    }

    // Resolve stage_id — use provided value or fall back to the first stage of the run
    let resolvedStageId = stage_id;
    if (!resolvedStageId) {
      const [stage] = await db
        .select({ id: research_stages.id })
        .from(research_stages)
        .where(eq(research_stages.research_run_id, runId))
        .limit(1);

      if (!stage) {
        throw new ApiError(
          "No stages found for this run. Provide a stage_id.",
          400,
          "NO_STAGES"
        );
      }
      resolvedStageId = stage.id;
    }

    const [task] = await db
      .insert(research_tasks)
      .values({
        research_run_id: runId,
        stage_id: resolvedStageId,
        task_key,
        task_type,
        agent_name: agent_name ?? null,
        input_json: input_json ?? {},
        priority: priority ?? 100,
      })
      .returning();

    return createdResponse(task);
  } catch (error) {
    return handleApiError(error);
  }
}
