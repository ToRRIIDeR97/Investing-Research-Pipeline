import postgres from "postgres";

// ============================================================
// Task Queue — manages research_tasks lifecycle.
// Tasks are agent-executable work items within a stage.
// Uses raw SQL with postgres.js tagged templates.
// ============================================================

export interface ResearchTask {
  id: string;
  research_run_id: string;
  stage_id: string;
  task_key: string;
  task_type: string;
  agent_name: string | null;
  status: string;
  priority: number;
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown> | null;
  validation_status: string | null;
  validation_result_json: Record<string, unknown> | null;
  retry_count: number;
  cost_usd: string;
  idempotency_key: string | null;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface EnqueueTaskInput {
  runId: string;
  stageId: string;
  taskKey: string;
  taskType: string;
  agentName?: string;
  inputJson?: Record<string, unknown>;
  priority?: number;
}

/**
 * Enqueue a new task into the research_tasks table.
 * Returns the generated task id.
 */
export async function enqueueTask(input: EnqueueTaskInput): Promise<string> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const idempotencyKey = `${input.runId}:${input.stageId}:${input.taskKey}`;
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 2))`;
      const active = await tx`
        SELECT 1
        FROM research_runs run
        JOIN research_stages stage ON stage.research_run_id = run.id
        WHERE run.id = ${input.runId} AND stage.id = ${input.stageId}
          AND run.status NOT IN ('failed', 'cancelled', 'completed')
          AND stage.status NOT IN ('failed', 'cancelled', 'completed', 'skipped')
        LIMIT 1
      `;
      if (!active[0]) throw new Error("Cannot enqueue a task for an inactive research run or stage");
      const existing = await tx`
        SELECT id, status FROM research_tasks
        WHERE idempotency_key = ${idempotencyKey}
        LIMIT 1
        FOR UPDATE
      `;
      if (existing[0]) {
        const task = existing[0];
        if (task.status === "completed" || task.status === "running") return task.id;
        await tx`
          UPDATE research_tasks
          SET status = 'pending',
              input_json = ${tx.json((input.inputJson || {}) as any)},
              priority = ${input.priority ?? 100},
              agent_name = ${input.agentName || null},
              retry_count = 0,
              failure_reason = NULL,
              output_json = NULL,
              validation_status = NULL,
              validation_result_json = NULL,
              started_at = NULL,
              completed_at = NULL,
              updated_at = NOW()
          WHERE id = ${task.id}
        `;
        return task.id;
      }
      const rows = await tx`
        INSERT INTO research_tasks (
          research_run_id, stage_id, task_key, task_type,
          agent_name, status, priority,
          input_json, idempotency_key
        ) VALUES (
          ${input.runId}, ${input.stageId}, ${input.taskKey}, ${input.taskType},
          ${input.agentName || null}, 'pending', ${input.priority ?? 100},
          ${tx.json((input.inputJson || {}) as any)}, ${idempotencyKey}
        )
        RETURNING id
      `;
      return rows[0].id;
    });
  } finally {
    await sql.end();
  }
}

/**
 * Claim the highest-priority pending task.
 * Atomically sets the task to 'running' status and returns it.
 * Returns null if no pending tasks are available.
 */
export async function claimNextTask(): Promise<ResearchTask | null> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      WITH next_task AS (
        SELECT task.id FROM research_tasks task
        JOIN research_runs run ON run.id = task.research_run_id
        JOIN research_stages stage ON stage.id = task.stage_id
        WHERE task.status = 'pending' AND run.status = 'running' AND stage.status = 'running'
        ORDER BY task.priority DESC, task.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE research_tasks AS task
      SET status = 'running', started_at = NOW(), updated_at = NOW()
      FROM next_task
      WHERE task.id = next_task.id
      RETURNING task.*
    `;

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as ResearchTask;
  } finally {
    await sql.end();
  }
}

/**
 * Mark a task as completed with its output.
 */
export async function completeTask(
  taskId: string,
  outputJson: Record<string, unknown>
): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      UPDATE research_tasks
      SET status = 'completed',
          output_json = ${sql.json(outputJson as any)},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${taskId} AND status = 'running'
      RETURNING id
    `;
    if (!rows[0]) throw new Error(`Task ${taskId} is no longer running`);
  } finally {
    await sql.end();
  }
}

/**
 * Mark a task as failed with a reason.
 */
export async function failTask(
  taskId: string,
  reason: string
): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      UPDATE research_tasks
      SET status = 'failed',
          failure_reason = ${reason},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${taskId} AND status = 'running'
      RETURNING id
    `;
    if (!rows[0]) throw new Error(`Task ${taskId} is no longer running`);
  } finally {
    await sql.end();
  }
}

/**
 * Retry a failed task: increment retry_count and reset to pending
 * if the count is still under the stage's max_retries.
 * Returns the updated task status.
 */
export async function retryTask(taskId: string): Promise<{
  retried: boolean;
  reason?: string;
}> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    return await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT rt.id, rt.retry_count, rt.status, rs.max_retries,
               rs.status AS stage_status, run.status AS run_status
        FROM research_tasks rt
        JOIN research_stages rs ON rt.stage_id = rs.id
        JOIN research_runs run ON rt.research_run_id = run.id
        WHERE rt.id = ${taskId}
        FOR UPDATE OF rt
      `;
      if (!rows[0]) return { retried: false, reason: "Task not found" };
      const task = rows[0];
      if (task.status !== "failed") {
        return { retried: false, reason: `Task is not in failed state (current: ${task.status})` };
      }
      if (task.run_status !== "running" || task.stage_status !== "running") {
        return { retried: false, reason: "Research run or stage is not active" };
      }
      const newRetryCount = Number(task.retry_count) + 1;
      const maxRetries = Number(task.max_retries);
      if (newRetryCount > maxRetries) {
        return { retried: false, reason: `Retry count (${newRetryCount}) exceeds max retries (${maxRetries})` };
      }
      await tx`
        UPDATE research_tasks
        SET status = 'pending', retry_count = ${newRetryCount}, failure_reason = NULL,
            started_at = NULL, completed_at = NULL, updated_at = NOW()
        WHERE id = ${taskId} AND status = 'failed'
      `;
      return { retried: true };
    });
  } finally {
    await sql.end();
  }
}

/**
 * Get all tasks for a specific stage in a run.
 */
export async function getTasksForStage(
  runId: string,
  stageId: string
): Promise<ResearchTask[]> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      SELECT
        id, research_run_id, stage_id, task_key, task_type,
        agent_name, status, priority,
        input_json, output_json,
        validation_status, validation_result_json,
        retry_count, cost_usd, idempotency_key,
        started_at, completed_at, failure_reason,
        created_at, updated_at
      FROM research_tasks
      WHERE research_run_id = ${runId}
        AND stage_id = ${stageId}
      ORDER BY priority DESC, created_at ASC
    `;

    return rows as unknown as ResearchTask[];
  } finally {
    await sql.end();
  }
}
