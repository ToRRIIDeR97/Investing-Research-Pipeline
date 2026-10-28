import { NextRequest } from "next/server";
import postgres from "postgres";
import { stageOutput, STAGED_SCHEMA_KEYS } from "@/lib/agents/staging";
import { handleApiError, createdResponse, ApiError } from "@/lib/api/errors";

/**
 * POST /api/research-runs/:id/stage-output
 * Stage an agent output for validation before promotion to final tables.
 * §29: stageAgentOutput domain command.
 * §9.2: agent output → staging record → schema validation → accept/reject → final table
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") throw new ApiError("A JSON object body is required", 400);
    // An unknown schema key would only fail later, at accept, with a 500 (#122).
    if (!STAGED_SCHEMA_KEYS.includes(body.output_schema_key)) {
      throw new ApiError(`output_schema_key must be one of: ${STAGED_SCHEMA_KEYS.join(", ")}`, 400, "UNKNOWN_SCHEMA_KEY");
    }
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw new ApiError("payload must be a JSON object", 400);
    }
    const sql = postgres(process.env.DATABASE_URL!);

    try {
      // Find the current running stage
      const stages = await sql`
        SELECT id FROM research_stages
        WHERE research_run_id = ${runId} AND status = 'running'
        ORDER BY stage_order ASC LIMIT 1
      `;
      if (stages.length === 0) {
        throw new ApiError("No running stage found for this run", 422);
      }
      const stageId = stages[0].id;

      // Find or create a task for this stage
      let taskId = body.task_id;
      if (!taskId) {
        const tasks = await sql`
          SELECT id FROM research_tasks
          WHERE stage_id = ${stageId} AND status = 'running'
          ORDER BY created_at DESC LIMIT 1
        `;
        if (tasks.length === 0) {
          throw new ApiError("No running task found. Provide task_id or create a task first.", 422);
        }
        taskId = tasks[0].id;
      }

      const result = await stageOutput({
        runId,
        stageId,
        taskId,
        targetTable: body.target_table,
        outputSchemaKey: body.output_schema_key,
        outputSchemaVersion: body.output_schema_version || 1,
        payload: body.payload,
        createdByAgent: body.created_by_agent || "unknown",
      });

      return createdResponse(result);
    } finally {
      await sql.end();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
