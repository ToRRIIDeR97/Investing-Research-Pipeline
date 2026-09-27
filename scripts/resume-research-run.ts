import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { enqueueResearchRun } from "../src/lib/research/run-queue";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const runId = process.env.RESEARCH_RUN_ID || "";
if (!runId) throw new Error("Set RESEARCH_RUN_ID to the research run to resume");

const provider = process.env.RESEARCH_ACCEPTANCE_PROVIDER || process.env.RESEARCH_MODEL_PROVIDER;
if (provider && provider !== "mock" && process.env.RUN_PAID_RESEARCH !== "1") {
  throw new Error("Set RUN_PAID_RESEARCH=1 to authorize a non-mock research run");
}
if (provider) process.env.RESEARCH_MODEL_PROVIDER = provider;

enqueueResearchRun(runId, "cli")
  .then((job) => console.log(JSON.stringify({ runId, jobId: job.id, status: job.status }, null, 2)))
  .catch((error) => { console.error("Pipeline resume failed:", error); process.exitCode = 1; });
