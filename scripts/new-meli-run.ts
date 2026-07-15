import postgres from "postgres";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createStagesForRun, approveResearchPlan } from "../src/lib/workflow/orchestrator";
import { runSystemResearchPipeline } from "../src/lib/research/system-pipeline";

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

const acceptanceProvider = process.env.RESEARCH_ACCEPTANCE_PROVIDER || "mock";
if (acceptanceProvider !== "mock" && process.env.RUN_PAID_MELI !== "1") {
  throw new Error("Set RUN_PAID_MELI=1 to authorize a non-mock MELI acceptance run");
}
process.env.RESEARCH_MODEL_PROVIDER = acceptanceProvider;

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  const runId = crypto.randomUUID();
  const assetId = "326e7eec-50ae-40dc-b334-b9b74e1b965e"; // MercadoLibre, Inc.
  const profileId = "917d1675-67d1-4dc3-bae6-69e9681c437c"; // Operating Company
  const profileVersion = 1;
  const cutoffAt = process.env.RESEARCH_ACCEPTANCE_CUTOFF_AT || new Date().toISOString();

  const researchQuestion = "Separate MercadoLibre's commerce and fintech economics; evaluate revenue and margin drivers, credit growth and loss quality, working-capital and funding needs, country and currency risk, competitive position, and valuation under base, bull, and bear scenarios.";

  console.log(`Inserting new MELI deep dive run ${runId}...`);
  await sql`
    INSERT INTO research_runs (
      id, asset_id, run_type, status, research_question, requested_by,
      profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
      budget_limit_usd, pipeline_version, metadata_json
    ) VALUES (
      ${runId}, ${assetId}, 'deep_dive', 'pending', ${researchQuestion}, 'system-test-harness',
      ${profileId}, ${profileVersion}, ${cutoffAt}, ${cutoffAt},
      ${process.env.RESEARCH_ACCEPTANCE_BUDGET_USD || "10.00"}, 2,
      ${sql.json({ acceptance_provider: acceptanceProvider, cutoff_at_utc: cutoffAt })}
    )
  `;

  console.log(`Initializing workflow stages for run ${runId}...`);
  await createStagesForRun(runId);

  console.log(`Starting system pipeline execution for run ${runId}...`);
  let result = await runSystemResearchPipeline(runId);
  console.log("Initial Result:", JSON.stringify(result, null, 2));

  // Loop to approve research plan and continue the pipeline
  let iterations = 0;
  while (result.status === "waiting_for_human" && iterations < 5) {
    iterations++;
    const [planStage] = await sql`SELECT status FROM research_stages WHERE research_run_id = ${runId} AND stage_key = 'research_plan'`;

    if (planStage && planStage.status === "waiting_for_human") {
      console.log(`\n[Iteration ${iterations}] Approving research plan human gate...`);
      await approveResearchPlan(runId, "system-test-harness");

      console.log("Resuming pipeline execution...");
      result = await runSystemResearchPipeline(runId);
      console.log("Result after plan approval:", JSON.stringify(result, null, 2));
    } else {
      break;
    }
  }

  // Query final run status and stats
  const [run] = await sql`SELECT status, actual_cost_usd, failure_reason FROM research_runs WHERE id = ${runId}`;
  console.log("\nFinal Run Details:");
  console.log(`Status: ${run.status}`);
  console.log(`Cost: USD ${run.actual_cost_usd}`);
  console.log(`Failure Reason: ${run.failure_reason}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error("Pipeline run failed:", err);
  await sql.end();
  process.exit(1);
});
