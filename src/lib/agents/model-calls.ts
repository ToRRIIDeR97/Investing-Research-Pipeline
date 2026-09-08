import postgres from "postgres";
import { ProviderError } from "../agent-harness/errors";

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
  costSource?: "provider" | "catalog_estimate" | "unknown";
  latencyMs?: number;
  status: string;
  errorMessage?: string;
  requestMetadata?: Record<string, unknown>;
  responseMetadata?: Record<string, unknown>;
  escalationReason?: string;
  reservationId?: string;
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
  checkpointKey?: string;
  checkpointAttemptLimit?: number;
  stageAttemptLimit?: number;
}

async function activeSpend(
  tx: ReturnType<typeof postgres> extends infer _ ? any : never,
  column: "research_run_id" | "stage_id" | "task_id",
  id: string
) {
  const spent = column === "research_run_id"
    ? await tx`SELECT COALESCE(SUM(cost_usd::numeric), 0) AS total FROM model_budget_ledger WHERE research_run_id = ${id}`
    : column === "stage_id"
      ? await tx`SELECT COALESCE(SUM(cost_usd::numeric), 0) AS total FROM model_budget_ledger WHERE stage_id = ${id}`
      : await tx`SELECT COALESCE(SUM(cost_usd::numeric), 0) AS total FROM model_budget_ledger WHERE task_id = ${id}`;
  const reserved = column === "research_run_id"
    ? await tx`SELECT COALESCE(SUM(reserved_usd::numeric), 0) AS total FROM model_budget_reservations WHERE research_run_id = ${id} AND status = 'pending' AND expires_at > NOW()`
    : column === "stage_id"
      ? await tx`SELECT COALESCE(SUM(reserved_usd::numeric), 0) AS total FROM model_budget_reservations WHERE stage_id = ${id} AND status = 'pending' AND expires_at > NOW()`
      : await tx`SELECT COALESCE(SUM(reserved_usd::numeric), 0) AS total FROM model_budget_reservations WHERE task_id = ${id} AND status = 'pending' AND expires_at > NOW()`;
  return Number(spent[0]?.total || 0) + Number(reserved[0]?.total || 0);
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

export async function assertModelBudgetAvailable(input: BudgetReservationInput): Promise<string | undefined> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx`UPDATE model_budget_reservations SET status = 'expired', resolved_at = NOW() WHERE status = 'pending' AND expires_at <= NOW()`;
      if (input.researchRunId) await tx`SELECT id FROM research_runs WHERE id = ${input.researchRunId} FOR UPDATE`;
      if (input.stageId) await tx`SELECT id FROM research_stages WHERE id = ${input.stageId} FOR UPDATE`;
      if (input.taskId) await tx`SELECT id FROM research_tasks WHERE id = ${input.taskId} FOR UPDATE`;
      if (input.stageId && input.checkpointKey) {
        // Reservations count even after failure/release, so a process restart cannot reset effort.
        const attempts = await tx`
          SELECT COUNT(*) AS stage_count,
            COUNT(*) FILTER (WHERE regexp_replace(rt.task_key, ':revision-[0-9]+$', '') = ${input.checkpointKey}) AS checkpoint_count
          FROM model_budget_reservations br JOIN research_tasks rt ON rt.id = br.task_id
          WHERE br.stage_id = ${input.stageId}
        `;
        if (input.stageAttemptLimit && Number(attempts[0].stage_count) >= input.stageAttemptLimit) {
          throw new ProviderError('Stage model-call budget exhausted, including prior resumes', 'budget_exhausted');
        }
        if (input.checkpointAttemptLimit && Number(attempts[0].checkpoint_count) >= input.checkpointAttemptLimit) {
          throw new ProviderError('Checkpoint attempt budget exhausted, including prior resumes', 'budget_exhausted');
        }
      }

      const checks: Array<{ scopeType: string; scopeId: string; column: "research_run_id" | "stage_id" | "task_id" }> = [];
      if (input.researchRunId) checks.push({ scopeType: "research_run", scopeId: input.researchRunId, column: "research_run_id" });
      if (input.stageId) checks.push({ scopeType: "stage", scopeId: input.stageId, column: "stage_id" });
      if (input.taskId) checks.push({ scopeType: "task", scopeId: input.taskId, column: "task_id" });
      for (const check of checks) {
        const limits = await tx`
          SELECT limit_usd FROM model_budget_limits
          WHERE scope_type = ${check.scopeType} AND scope_id = ${check.scopeId}
            AND (model_tier IS NULL OR model_tier = ${input.modelTier}) AND hard_limit = true
        `;
        const used = await activeSpend(tx, check.column, check.scopeId);
        for (const limit of limits) {
          if (used + input.reserveUsd > Number(limit.limit_usd)) {
            throw new Error(`${check.scopeType} budget exceeded: $${(used + input.reserveUsd).toFixed(4)} > $${Number(limit.limit_usd).toFixed(4)}`);
          }
        }
      }
      if (input.researchRunId) {
        const runs = await tx`SELECT budget_limit_usd, actual_cost_usd FROM research_runs WHERE id = ${input.researchRunId}`;
        const limit = Number(runs[0]?.budget_limit_usd || 0);
        const used = await activeSpend(tx, "research_run_id", input.researchRunId);
        if (limit > 0 && used + input.reserveUsd > limit) {
          throw new Error(`research_run budget exceeded: reserve would exceed $${limit.toFixed(4)}`);
        }
      }
      const rows = await tx`
        INSERT INTO model_budget_reservations (research_run_id, stage_id, task_id, model_tier, reserved_usd, expires_at)
        VALUES (${input.researchRunId || null}, ${input.stageId || null}, ${input.taskId || null}, ${input.modelTier}, ${input.reserveUsd.toString()}, NOW() + INTERVAL '15 minutes')
        RETURNING id
      `;
      return String(rows[0].id);
    });
  } finally {
    await sql.end();
  }
}

export async function releaseModelBudgetReservation(reservationId: string): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    await sql`UPDATE model_budget_reservations SET status = 'released', resolved_at = NOW() WHERE id = ${reservationId} AND status = 'pending'`;
  } finally {
    await sql.end();
  }
}

export async function recordModelCall(input: RecordModelCallInput): Promise<string> {
  if (input.modelTier === "premium" && !input.escalationReason) {
    throw new Error("Premium model calls require escalationReason");
  }

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const budget = await checkBudget(sql, input);
    // Calls already incurred must be recorded even if the provider exceeded its reservation.
    // The next preflight enforces the limit using this actual spend.

    const cost = input.costUsd ?? 0;
    const requestMetadata = {
      ...(input.requestMetadata || {}),
      ...(input.escalationReason ? { escalation_reason: input.escalationReason } : {}),
      ...(budget.exceeded ? { budget_overrun: budget.reason } : {}),
    };

    const callId = await sql.begin(async (tx) => {
      if (input.researchRunId) await tx`SELECT id FROM research_runs WHERE id = ${input.researchRunId} FOR UPDATE`;
      if (input.stageId) await tx`SELECT id FROM research_stages WHERE id = ${input.stageId} FOR UPDATE`;
      if (input.taskId) await tx`SELECT id FROM research_tasks WHERE id = ${input.taskId} FOR UPDATE`;

      // A successful provider response may cost more than the conservative
      // reservation. Re-check the hard limits while the scope rows are locked.
      if (input.reservationId) {
        await tx`UPDATE model_budget_reservations SET status = 'consumed', resolved_at = NOW() WHERE id = ${input.reservationId} AND status = 'pending'`;
      }
      const recordChecks: Array<{ scopeType: string; scopeId: string; column: "research_run_id" | "stage_id" | "task_id" }> = [];
      if (input.researchRunId) recordChecks.push({ scopeType: "research_run", scopeId: input.researchRunId, column: "research_run_id" });
      if (input.stageId) recordChecks.push({ scopeType: "stage", scopeId: input.stageId, column: "stage_id" });
      if (input.taskId) recordChecks.push({ scopeType: "task", scopeId: input.taskId, column: "task_id" });
      for (const check of recordChecks) {
        const limits = await tx`
          SELECT limit_usd FROM model_budget_limits
          WHERE scope_type = ${check.scopeType} AND scope_id = ${check.scopeId}
            AND (model_tier IS NULL OR model_tier = ${input.modelTier}) AND hard_limit = true
        `;
        const projected = await activeSpend(tx, check.column, check.scopeId) + cost;
        for (const limit of limits) {
          if (projected > Number(limit.limit_usd)) {
            Object.assign(requestMetadata, { budget_overrun: `${check.scopeType} budget exceeded: $${projected.toFixed(4)} > $${Number(limit.limit_usd).toFixed(4)}` });
          }
        }
      }
      const rows = await tx`
        INSERT INTO model_call_logs (
          research_run_id, stage_id, task_id, agent_name,
          model_provider, model_name, model_tier, prompt_version,
          input_tokens, output_tokens, cost_usd, latency_ms,
          cost_source, status, error_message, request_metadata_json, response_metadata_json
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
          ${input.costSource || "unknown"},
          ${input.status},
          ${input.errorMessage || null},
          ${sql.json(requestMetadata)},
          ${sql.json((input.responseMetadata || {}) as any)}
        )
        RETURNING id
      `;

      await tx`
        INSERT INTO model_budget_ledger (
          model_call_log_id, research_run_id, stage_id, task_id, model_tier, cost_usd, cost_source
        ) VALUES (
          ${rows[0].id},
          ${input.researchRunId || null},
          ${input.stageId || null},
          ${input.taskId || null},
          ${input.modelTier},
          ${cost.toString()},
          ${input.costSource || "unknown"}
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
