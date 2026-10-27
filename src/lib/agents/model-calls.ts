import postgres from "postgres";
import { pipelineSql } from "@/db/pipeline-sql";

interface RecordModelCallInput {
  researchRunId?: string;
  stageId?: string;
  taskId?: string;
  agentName?: string;
  modelProvider: string;
  modelName: string;
  modelTier: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  status: string;
  errorMessage?: string;
  requestMetadata?: Record<string, unknown>;
  responseMetadata?: Record<string, unknown>;
  escalationReason?: string;
}

interface BudgetCheck {
  exceeded: boolean;
  reason?: string;
}

export interface BudgetReservationInput {
  researchRunId?: string;
  stageId?: string;
  taskId?: string;
  modelTier: string;
  reserveUsd: number;
}

async function checkBudget(
  sql: ReturnType<typeof postgres>,
  input: RecordModelCallInput
): Promise<BudgetCheck> {
  const cost = input.costUsd ?? 0;
  if (cost <= 0) {
    return { exceeded: false };
  }

  const checks: Array<{ scopeType: string; scopeId?: string }> = [
    { scopeType: "research_run", scopeId: input.researchRunId },
    { scopeType: "stage", scopeId: input.stageId },
    { scopeType: "task", scopeId: input.taskId },
  ];

  for (const check of checks) {
    if (!check.scopeId) continue;

    const limits = await sql`
      SELECT id, limit_usd, hard_limit, model_tier
      FROM model_budget_limits
      WHERE scope_type = ${check.scopeType}
        AND scope_id = ${check.scopeId}
        AND (model_tier IS NULL OR model_tier = ${input.modelTier})
        AND hard_limit = true
    `;

    for (const limit of limits) {
      const spentRows = await sql`
        SELECT COALESCE(SUM(amount), 0) AS total FROM (
        SELECT cost_usd::numeric AS amount FROM model_budget_ledger WHERE
          (${check.scopeType === "research_run" ? sql`research_run_id = ${check.scopeId}` : sql`false`})
          OR (${check.scopeType === "stage" ? sql`stage_id = ${check.scopeId}` : sql`false`})
          OR (${check.scopeType === "task" ? sql`task_id = ${check.scopeId}` : sql`false`})
        UNION ALL
        SELECT COALESCE(budget_reservation_usd, 0) FROM research_tasks
        WHERE status = 'running' AND id IS DISTINCT FROM ${input.taskId || null}::uuid AND (
          (${check.scopeType === "research_run" ? sql`research_run_id = ${check.scopeId}` : sql`false`})
          OR (${check.scopeType === "stage" ? sql`stage_id = ${check.scopeId}` : sql`false`})
          OR (${check.scopeType === "task" ? sql`id = ${check.scopeId}` : sql`false`})
        )) AS committed
      `;
      const projected = Number(spentRows[0].total) + cost;
      const limitUsd = Number(limit.limit_usd);
      if (projected > limitUsd) {
        return {
          exceeded: true,
          reason: `${check.scopeType} budget exceeded: $${projected.toFixed(4)} > $${limitUsd.toFixed(4)}`,
        };
      }
    }
  }

  if (input.researchRunId) {
    const runs = await sql`
      SELECT budget_limit_usd, actual_cost_usd,
        (SELECT COALESCE(SUM(budget_reservation_usd), 0)
         FROM research_tasks WHERE research_run_id = ${input.researchRunId} AND status = 'running'
           AND id IS DISTINCT FROM ${input.taskId || null}::uuid) AS reserved
      FROM research_runs WHERE id = ${input.researchRunId}
    `;
    if (runs[0]?.budget_limit_usd) {
      const projected = Number(runs[0].actual_cost_usd || 0) + Number(runs[0].reserved || 0) + cost;
      const limitUsd = Number(runs[0].budget_limit_usd);
      if (projected > limitUsd) {
        return {
          exceeded: true,
          reason: `research_run budget exceeded: $${projected.toFixed(4)} > $${limitUsd.toFixed(4)}`,
        };
      }
    }
  }

  return { exceeded: false };
}

/** The run or another budget scope has no room for the next model attempt. */
export class ModelBudgetExhausted extends Error {}

export async function assertModelBudgetAvailable(input: BudgetReservationInput): Promise<void> {
  const sql = pipelineSql();
  if (!Number.isFinite(input.reserveUsd) || input.reserveUsd <= 0) throw new Error("Attempt budget reservation must be positive");
  await sql.begin(async tx => {
    if (input.researchRunId) await tx`SELECT id FROM research_runs WHERE id = ${input.researchRunId} FOR UPDATE`;
    const result = await checkBudget(tx as unknown as ReturnType<typeof postgres>, {
      modelProvider: "budget-preflight", modelName: "pending", status: "preflight", ...input, costUsd: input.reserveUsd,
    });
    if (result.exceeded) throw new ModelBudgetExhausted(result.reason || "Model budget exhausted");
    // A narrow column, so reserving never rewrites the task's (often MB-sized) input_json.
    if (input.taskId) await tx`UPDATE research_tasks SET budget_reservation_usd = ${input.reserveUsd} WHERE id = ${input.taskId}`;
  });
}

/** PostgreSQL rejects NUL in text and jsonb; provider error bodies and excerpts can carry it. */
function withoutNul<T>(value: T): T {
  // Drops each escaped NUL, but not an escaped backslash followed by the text "u0000".
  return JSON.parse(JSON.stringify(value ?? {}).replace(/(?<!\\)((?:\\\\)*)\\u0000/g, "$1"));
}

export async function recordModelCall(input: RecordModelCallInput): Promise<string> {
  if (input.modelTier === "premium" && !input.escalationReason) {
    throw new Error("Premium model calls require escalationReason");
  }

  const sql = pipelineSql();

  const cost = input.costUsd ?? 0;
  const errorMessage = input.errorMessage?.replace(/\u0000/g, "");
  const requestMetadata = {
    ...(input.requestMetadata || {}),
    ...(input.escalationReason ? { escalation_reason: input.escalationReason } : {}),
  };

  const write = (requestJson: Record<string, unknown>, responseJson: Record<string, unknown>, message?: string) => sql.begin(async (tx) => {
    // Actual spend must be recorded even if the provider exceeded the estimate.
    if (input.researchRunId) await tx`SELECT id FROM research_runs WHERE id = ${input.researchRunId} FOR UPDATE`;
    if (input.taskId) await tx`UPDATE research_tasks SET budget_reservation_usd = NULL WHERE id = ${input.taskId}`;
    const rows = await tx`
      INSERT INTO model_call_logs (
        research_run_id, stage_id, task_id, agent_name,
        model_provider, model_name, model_tier, prompt_version,
        input_tokens, output_tokens, cost_usd, latency_ms,
        status, error_message, request_metadata_json, response_metadata_json
      ) VALUES (
        ${input.researchRunId || null},
        ${input.stageId || null},
        ${input.taskId || null},
        ${input.agentName || null},
        ${input.modelProvider},
        ${input.modelName},
        ${input.modelTier},
        ${input.promptVersion || null},
        ${input.inputTokens || null},
        ${input.outputTokens || null},
        ${cost.toString()},
        ${input.latencyMs || null},
        ${input.status},
        ${message || null},
        ${sql.json(requestJson as any)},
        ${sql.json(responseJson as any)}
      )
      RETURNING id
    `;

    await tx`
      INSERT INTO model_budget_ledger (
        model_call_log_id, research_run_id, stage_id, task_id, model_tier, cost_usd
      ) VALUES (
        ${rows[0].id},
        ${input.researchRunId || null},
        ${input.stageId || null},
        ${input.taskId || null},
        ${input.modelTier},
        ${cost.toString()}
      )
    `;

    if (input.researchRunId && cost > 0) {
      await tx`
        UPDATE research_runs
        SET actual_cost_usd = actual_cost_usd + ${cost.toString()}::numeric,
            updated_at = NOW()
        WHERE id = ${input.researchRunId}
      `;
    }

    if (input.taskId && cost > 0) {
      await tx`
        UPDATE research_tasks
        SET cost_usd = cost_usd + ${cost.toString()}::numeric,
            updated_at = NOW()
        WHERE id = ${input.taskId}
      `;
    }

    return rows[0].id as string;
  });

  try {
    return await write(withoutNul(requestMetadata), withoutNul(input.responseMetadata || {}), errorMessage);
  } catch (error) {
    // The spend must reach the ledger even when the call's metadata cannot be stored.
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    return await write({ metadata_dropped: true }, { metadata_dropped: reason }, errorMessage?.slice(0, 2_000));
  }
}
