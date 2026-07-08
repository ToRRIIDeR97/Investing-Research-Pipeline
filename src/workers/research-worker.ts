import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { executeBacktestTask } from "@/lib/backtesting/executor";
import type { ResearchTask } from "@/lib/workflow/task-queue";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;

  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    const rawValue = valueParts.join("=").trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const once = process.argv.includes("--once");
const pollIntervalMs = Number(
  process.argv.find((arg) => arg.startsWith("--poll-interval-ms="))?.split("=")[1] || 5000
);

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function claimNextBacktestTask(): Promise<ResearchTask | null> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      UPDATE research_tasks
      SET status = 'running',
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM research_tasks
        WHERE status = 'pending'
          AND task_type = 'backtest'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id, research_run_id, stage_id, task_key, task_type,
        agent_name, status, priority,
        input_json, output_json,
        validation_status, validation_result_json,
        retry_count, cost_usd, idempotency_key,
        started_at, completed_at, failure_reason,
        created_at, updated_at
    `;

    return (rows[0] as unknown as ResearchTask) || null;
  } finally {
    await sql.end();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for worker:research");
  }

  console.log(`research-worker started${once ? " in --once mode" : ""}`);

  let shouldStop = false;
  process.once("SIGINT", () => {
    shouldStop = true;
  });
  process.once("SIGTERM", () => {
    shouldStop = true;
  });

  do {
    const task = await claimNextBacktestTask();
    if (!task) {
      if (once) break;
      await sleep(pollIntervalMs);
      continue;
    }

    console.log(`claimed backtest task ${task.id}`);
    try {
      await executeBacktestTask(task);
      console.log(`completed backtest task ${task.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed backtest task ${task.id}: ${message}`);
    }
  } while (!once && !shouldStop);

  console.log("research-worker stopped");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
