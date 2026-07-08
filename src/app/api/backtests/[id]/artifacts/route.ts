import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_tasks } from "@/db/schema/workflow";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import {
  getBacktestRun,
  listBacktestArtifacts,
} from "@/lib/backtesting/service";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const backtest = await getBacktestRun(id);
    if (backtest) {
      const artifacts = await listBacktestArtifacts(id);
      return successResponse({
        id: backtest.id,
        research_run_id: backtest.research_run_id,
        research_task_id: backtest.research_task_id,
        status: backtest.status,
        artifacts,
      });
    }

    const [task] = await db
      .select({
        id: research_tasks.id,
        research_run_id: research_tasks.research_run_id,
        task_key: research_tasks.task_key,
        task_type: research_tasks.task_type,
        status: research_tasks.status,
        output_json: research_tasks.output_json,
      })
      .from(research_tasks)
      .where(eq(research_tasks.id, id))
      .limit(1);

    if (!task) {
      throw new ApiError("Backtest task not found", 404, "NOT_FOUND");
    }

    return successResponse({
      id: task.id,
      research_run_id: task.research_run_id,
      task_key: task.task_key,
      task_type: task.task_type,
      status: task.status,
      artifacts: task.output_json,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
