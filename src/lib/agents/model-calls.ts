import postgres from "postgres";

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
        SELECT COALESCE(SUM(cost_usd::numeric), 0) as total
        FROM model_budget_ledger
        WHERE
          (${check.scopeType === "research_run" ? sql`research_run_id = ${check.scopeId}` : sql`false`})
          OR (${check.scopeType === "stage" ? sql`stage_id = ${check.scopeId}` : sql`false`})
          OR (${check.scopeType === "task" ? sql`task_id = ${check.scopeId}` : sql`false`})
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
      SELECT budget_limit_usd, actual_cost_usd
      FROM research_runs
      WHERE id = ${input.researchRunId}
    `;
    if (runs[0]?.budget_limit_usd) {
      const projected = Number(runs[0].actual_cost_usd || 0) + cost;
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

export async function recordModelCall(input: RecordModelCallInput): Promise<string> {
  if (input.modelTier === "premium" && !input.escalationReason) {
    throw new Error("Premium model calls require escalationReason");
  }

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const budget = await checkBudget(sql, input);
    if (budget.exceeded) {
      throw new Error(budget.reason);
    }

    const cost = input.costUsd ?? 0;
    const requestMetadata = {
      ...(input.requestMetadata || {}),
      ...(input.escalationReason ? { escalation_reason: input.escalationReason } : {}),
    };

    const callId = await sql.begin(async (tx) => {
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
          ${input.errorMessage || null},
          ${JSON.stringify(requestMetadata)}::jsonb,
          ${JSON.stringify(input.responseMetadata || {})}::jsonb
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

      return rows[0].id;
    });

    return callId;
  } finally {
    await sql.end();
  }
}
