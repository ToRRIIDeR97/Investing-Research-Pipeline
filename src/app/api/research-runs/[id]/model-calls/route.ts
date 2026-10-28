import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { model_call_logs } from "@/db/schema/ai";
import { research_runs, research_stages, research_tasks } from "@/db/schema/workflow";
import { recordModelCall } from "@/lib/agents/model-calls";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import { and, eq, desc, gt } from "drizzle-orm";

// The fields the run page lists. Request and response metadata are most of a row's size.
const summaryFields = {
  id: model_call_logs.id,
  agent_name: model_call_logs.agent_name,
  model_provider: model_call_logs.model_provider,
  model_name: model_call_logs.model_name,
  model_tier: model_call_logs.model_tier,
  status: model_call_logs.status,
  cost_usd: model_call_logs.cost_usd,
  latency_ms: model_call_logs.latency_ms,
  created_at: model_call_logs.created_at,
  error_message: model_call_logs.error_message,
};

const DEFAULT_MODEL_CALL_LIMIT = 500;
const MAX_MODEL_CALL_LIMIT = 1000;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MODEL_CALL_LIMIT).default(DEFAULT_MODEL_CALL_LIMIT),
  since: z.coerce.date().optional(),
});

// Spend and ids feed the budget ledger: a negative cost would lower the spend checkBudget sums.
const amount = z.number().finite().min(0);
const modelCallBodySchema = z.object({
  model_provider: z.string().min(1),
  model_name: z.string().min(1),
  model_tier: z.string().min(1),
  status: z.string().min(1),
  stage_id: z.string().uuid().nullish(),
  task_id: z.string().uuid().nullish(),
  agent_name: z.string().nullish(),
  prompt_version: z.string().nullish(),
  input_tokens: amount.int().nullish(),
  output_tokens: amount.int().nullish(),
  cost_usd: amount.nullish(),
  latency_ms: amount.nullish(),
  error_message: z.string().nullish(),
  request_metadata_json: z.record(z.string(), z.unknown()).nullish(),
  response_metadata_json: z.record(z.string(), z.unknown()).nullish(),
  escalation_reason: z.string().nullish(),
});

/**
 * Newest first, at most `limit` rows (default 500, max 1000). `since` (an ISO time) returns only rows created after
 * it, so a poller can fetch just the new calls. `?summary=1` returns only summaryFields; the run page polls it.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const search = request.nextUrl.searchParams;
    const summary = search.get("summary") === "1";
    const query = listQuerySchema.safeParse({ limit: search.get("limit") ?? undefined, since: search.get("since") ?? undefined });
    if (!query.success) throw new ApiError("limit must be 1-1000 and since an ISO time", 400, "VALIDATION_ERROR");
    const { limit, since } = query.data;

    const logs = await (summary ? db.select(summaryFields) : db.select())
      .from(model_call_logs)
      .where(and(eq(model_call_logs.research_run_id, runId), since ? gt(model_call_logs.created_at, since) : undefined))
      .orderBy(desc(model_call_logs.created_at))
      .limit(limit);

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
    const parsed = modelCallBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new ApiError(
        "model_provider, model_name, model_tier and status are required; ids must be UUIDs and amounts finite numbers of at least 0",
        400,
        "VALIDATION_ERROR"
      );
    }
    const body = parsed.data;

    // The ids scope budget limits and reservations, so they must belong to this run.
    const [run] = await db.select({ id: research_runs.id }).from(research_runs).where(eq(research_runs.id, runId)).limit(1);
    if (!run) throw new ApiError("Research run not found", 404, "NOT_FOUND");
    if (body.stage_id) {
      const [stage] = await db.select({ id: research_stages.id }).from(research_stages)
        .where(and(eq(research_stages.id, body.stage_id), eq(research_stages.research_run_id, runId))).limit(1);
      if (!stage) throw new ApiError("stage_id does not belong to this run", 400, "VALIDATION_ERROR");
    }
    if (body.task_id) {
      const [task] = await db.select({ stage_id: research_tasks.stage_id }).from(research_tasks)
        .where(and(eq(research_tasks.id, body.task_id), eq(research_tasks.research_run_id, runId))).limit(1);
      if (!task || (body.stage_id && task.stage_id !== body.stage_id)) {
        throw new ApiError("task_id does not belong to this run and stage", 400, "VALIDATION_ERROR");
      }
    }

    const id = await recordModelCall({
      researchRunId: runId,
      stageId: body.stage_id ?? undefined,
      taskId: body.task_id ?? undefined,
      agentName: body.agent_name ?? undefined,
      modelProvider: body.model_provider,
      modelName: body.model_name,
      modelTier: body.model_tier,
      promptVersion: body.prompt_version ?? undefined,
      inputTokens: body.input_tokens ?? undefined,
      outputTokens: body.output_tokens ?? undefined,
      costUsd: body.cost_usd ?? undefined,
      latencyMs: body.latency_ms ?? undefined,
      status: body.status,
      errorMessage: body.error_message ?? undefined,
      requestMetadata: body.request_metadata_json ?? undefined,
      responseMetadata: body.response_metadata_json ?? undefined,
      escalationReason: body.escalation_reason ?? undefined,
    });

    return createdResponse({ id });
  } catch (error) {
    return handleApiError(error);
  }
}
