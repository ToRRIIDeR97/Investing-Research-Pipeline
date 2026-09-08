import { hostname } from "node:os";
import postgres from "postgres";
import { executeBacktestTask } from "@/lib/backtesting/executor";
import { loadResearchEnvFiles } from "@/lib/config/research-env";
import { runSystemResearchPipeline } from "@/lib/research/system-pipeline";
import {
  claimNextResearchRun,
  completeResearchRunJob,
  failResearchRunJob,
  markWorkerStopped,
  recordWorkerHeartbeat,
  renewResearchRunLease,
  requeueExpiredResearchRunJobs,
  DEFAULT_RESEARCH_RUN_LEASE_MS,
} from "@/lib/research/run-queue";
import type { ResearchTask } from "@/lib/workflow/task-queue";

loadResearchEnvFiles();

const once = process.argv.includes("--once");
const pollIntervalMs = Number(
  process.argv.find((arg) => arg.startsWith("--poll-interval-ms="))?.split("=")[1] || 5000
);
const workerId = process.argv.find((arg) => arg.startsWith("--worker-id="))?.split("=")[1]
  || `${hostname()}:${process.pid}`;

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function claimNextBacktestTask(): Promise<ResearchTask | null> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const rows = await sql`
      WITH next_task AS (
        SELECT task.id FROM research_tasks task
        JOIN research_runs run ON run.id = task.research_run_id
        JOIN research_stages stage ON stage.id = task.stage_id
        WHERE task.status = 'pending' AND task.task_type = 'backtest'
          AND run.status = 'running' AND stage.status = 'running'
        ORDER BY task.priority DESC, task.created_at ASC
        LIMIT 1 FOR UPDATE OF task SKIP LOCKED
      )
      UPDATE research_tasks AS task
      SET status = 'running', started_at = COALESCE(task.started_at, NOW()), updated_at = NOW()
      FROM next_task
      WHERE task.id = next_task.id
      RETURNING id, research_run_id, stage_id, task_key, task_type,
        agent_name, status, priority, input_json, output_json,
        validation_status, validation_result_json, retry_count, cost_usd,
        idempotency_key, started_at, completed_at, failure_reason,
        created_at, updated_at
    `;
    return (rows[0] as unknown as ResearchTask) || null;
  } finally {
    await sql.end();
  }
}

export async function processNextResearchRunJob(): Promise<boolean> {
  await requeueExpiredResearchRunJobs();
  const job = await claimNextResearchRun(workerId);
  if (!job) return false;

  console.log(`claimed research run job ${job.id} for run ${job.research_run_id}`);
  const renewInterval = setInterval(() => {
    void renewResearchRunLease(job.id, workerId).catch((error) => {
      console.error(`failed to renew lease for job ${job.id}:`, error);
    });
  }, Math.max(1000, Math.floor(DEFAULT_RESEARCH_RUN_LEASE_MS / 3)));

  try {
    const result = await runSystemResearchPipeline(job.research_run_id);
    await completeResearchRunJob(job.id, workerId, {
      ...result,
      worker_execution: "success",
      completed_at: new Date().toISOString(),
    });
    console.log(`completed research run job ${job.id} with workflow status ${result.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failResearchRunJob(job.id, workerId, message);
    console.error(`failed research run job ${job.id}: ${message}`);
  } finally {
    clearInterval(renewInterval);
  }
  return true;
}

async function processNextBacktestTask(): Promise<boolean> {
  const task = await claimNextBacktestTask();
  if (!task) return false;
  console.log(`claimed backtest task ${task.id}`);
  try {
    await executeBacktestTask(task);
    console.log(`completed backtest task ${task.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed backtest task ${task.id}: ${message}`);
  }
  return true;
}

export async function runResearchWorker() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for worker:research");
  let shouldStop = false;
  const stop = () => { shouldStop = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await recordWorkerHeartbeat(workerId, { pid: process.pid, mode: once ? "once" : "poll" });
  const heartbeatInterval = setInterval(() => {
    void recordWorkerHeartbeat(workerId, { pid: process.pid, mode: once ? "once" : "poll" }).catch((error) => {
      console.error("failed to record worker heartbeat:", error);
    });
  }, 10_000);

  console.log(`research-worker ${workerId} started${once ? " in --once mode" : ""}`);
  try {
    do {
      const processedRun = await processNextResearchRunJob();
      const processedTask = processedRun ? false : await processNextBacktestTask();
      if (!processedRun && !processedTask) {
        if (once) break;
        await sleep(pollIntervalMs);
      }
    } while (!once && !shouldStop);
  } finally {
    clearInterval(heartbeatInterval);
    await markWorkerStopped(workerId).catch((error) => console.error("failed to stop heartbeat:", error));
    console.log("research-worker stopped");
  }
}

runResearchWorker().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
