import postgres from "postgres";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

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

const runId = "76355c02-b88f-4b44-b65a-9af20896392d";
const sql = postgres(process.env.DATABASE_URL!);

async function monitor() {
  console.log(`Monitoring progress of run ${runId}...`);
  while (true) {
    const [run] = await sql`
      SELECT status, failure_reason FROM research_runs WHERE id = ${runId}
    `;
    const stages = await sql`
      SELECT stage_key, status, failure_reason 
      FROM research_stages 
      WHERE research_run_id = ${runId} 
      ORDER BY id ASC
    `;
    const tasks = await sql`
      SELECT task_key, status, cost_usd 
      FROM research_tasks 
      WHERE research_run_id = ${runId} 
      ORDER BY id ASC
    `;

    console.clear();
    console.log(`=== RUN ID: ${runId} ===`);
    console.log(`Status: ${run?.status} | Failure Reason: ${run?.failure_reason || "none"}`);
    console.log("\n--- Stages ---");
    for (const stage of stages) {
      console.log(`  ${stage.stage_key.padEnd(25)}: ${stage.status.padEnd(15)} ${stage.failure_reason ? `(${stage.failure_reason})` : ""}`);
    }
    console.log("\n--- Running/Recent Tasks ---");
    for (const task of tasks.slice(-5)) {
      console.log(`  ${task.task_key.padEnd(30)}: ${task.status.padEnd(15)} Cost: $${Number(task.cost_usd || 0).toFixed(4)}`);
    }

    if (run?.status === "failed" || run?.status === "completed" || run?.status === "needs_more_work") {
      console.log(`\nRun finished in state: ${run?.status}`);
      break;
    }

    // Check if human review is waiting
    const hrStage = stages.find(s => s.stage_key === "human_review");
    if (hrStage && (hrStage.status === "waiting_for_human" || hrStage.status === "completed")) {
      console.log(`\nRun reached human review stage checkpoint!`);
      break;
    }

    await new Promise(r => setTimeout(r, 10000));
  }
}

monitor().then(() => sql.end()).catch(console.error);
