import { NextRequest } from "next/server";
import { db } from "@/db";
import { model_call_logs } from "@/db/schema/ai";
import { recordModelCall } from "@/lib/agents/model-calls";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const logs = await db
      .select()
      .from(model_call_logs)
      .where(eq(model_call_logs.research_run_id, runId))
      .orderBy(desc(model_call_logs.created_at));

    return successResponse(logs);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const body = await request.json();

    if (!body.model_provider || !body.model_name || !body.model_tier || !body.status) {
      throw new ApiError(
        "model_provider, model_name, model_tier, and status are required",
        400,
        "VALIDATION_ERROR"
      );
    }

    const id = await recordModelCall({
      researchRunId: runId,
      stageId: body.stage_id,
      taskId: body.task_id,
      agentName: body.agent_name,
      modelProvider: body.model_provider,
      modelName: body.model_name,
      modelTier: body.model_tier,
      promptVersion: body.prompt_version,
      inputTokens: body.input_tokens,
      outputTokens: body.output_tokens,
      costUsd: body.cost_usd,
      latencyMs: body.latency_ms,
      status: body.status,
      errorMessage: body.error_message,
      requestMetadata: body.request_metadata_json,
      responseMetadata: body.response_metadata_json,
      escalationReason: body.escalation_reason,
    });

    return createdResponse({ id });
  } catch (error) {
    return handleApiError(error);
  }
}
