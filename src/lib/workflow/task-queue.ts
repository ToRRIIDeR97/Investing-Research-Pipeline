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

    // Check if a task with this idempotency key already exists
    const existing = await sql`
      SELECT id, status FROM research_tasks
      WHERE idempotency_key = ${idempotencyKey}
    `;

    if (existing.length > 0) {
      const task = existing[0];
      // If it's already completed or running, return existing id
      if (task.status === "completed" || task.status === "running") {
        return task.id;
      }
      // If it's pending or failed, we can re-use the slot — just reset it
      await sql`
        UPDATE research_tasks
        SET status = 'pending',
            input_json = ${JSON.stringify(input.inputJson || {})}::jsonb,
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

    const rows = await sql`
      INSERT INTO research_tasks (
        research_run_id, stage_id, task_key, task_type,
        agent_name, status, priority,
        input_json, idempotency_key
      ) VALUES (
        ${input.runId}, ${input.stageId}, ${input.taskKey}, ${input.taskType},
        ${input.agentName || null}, 'pending', ${input.priority ?? 100},
        ${JSON.stringify(input.inputJson || {})}::jsonb,
        ${idempotencyKey}
      )
      RETURNING id
    `;

    return rows[0].id;
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
    // Use SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent access
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
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    if (rows.length === 0) {
      return null;
    }

    const taskId = rows[0].id;

    await sql`
      UPDATE research_tasks
      SET status = 'running',
          started_at = NOW(),
          updated_at = NOW()
      WHERE id = ${taskId}
    `;

    // Return the updated task
    const task = rows[0] as ResearchTask;
    task.status = "running";
    task.started_at = new Date().toISOString();
    return task;
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
    await sql`
      UPDATE research_tasks
      SET status = 'completed',
          output_json = ${JSON.stringify(outputJson)}::jsonb,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${taskId}
    `;
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
    await sql`
      UPDATE research_tasks
      SET status = 'failed',
          failure_reason = ${reason},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${taskId}
    `;
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
    // Fetch the task and its stage's max_retries
    const rows = await sql`
      SELECT
        rt.id,
        rt.retry_count,
        rt.status,
        rs.max_retries
      FROM research_tasks rt
      JOIN research_stages rs ON rt.stage_id = rs.id
      WHERE rt.id = ${taskId}
    `;

    if (rows.length === 0) {
      return { retried: false, reason: "Task not found" };
    }

    const task = rows[0];

    if (task.status !== "failed") {
      return {
        retried: false,
        reason: `Task is not in failed state (current: ${task.status})`,
      };
    }

    const newRetryCount = Number(task.retry_count) + 1;
    const maxRetries = Number(task.max_retries);

    if (newRetryCount > maxRetries) {
      return {
        retried: false,
        reason: `Retry count (${newRetryCount}) exceeds max retries (${maxRetries})`,
      };
    }

    await sql`
      UPDATE research_tasks
      SET status = 'pending',
          retry_count = ${newRetryCount},
          failure_reason = NULL,
          started_at = NULL,
          completed_at = NULL,
          updated_at = NOW()
      WHERE id = ${taskId}
    `;

    return { retried: true };
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
