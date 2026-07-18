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
if (acceptanceProvider !== "mock" && process.env.RUN_PAID_RESEARCH !== "1") {
  throw new Error("Set RUN_PAID_RESEARCH=1 to authorize a non-mock research run");
}
process.env.RESEARCH_MODEL_PROVIDER = acceptanceProvider;

const requestedAsset = (process.env.RESEARCH_ASSET || "SOFI").trim();
const requestedPipelineVersion = Number(process.env.RESEARCH_PIPELINE_VERSION || "2");
if (requestedPipelineVersion !== 2 && requestedPipelineVersion !== 3) {
  throw new Error(
    "The executable system pipeline currently supports pipeline version 2 and 3 only"
  );
}

const sql = postgres(process.env.DATABASE_URL!);

function defaultResearchQuestion(symbol: string, name: string) {
  if (symbol.toUpperCase() === "SOFI") {
    return [
      "Explain why SoFi was founded and how its strategic identity evolved from student-loan refinancing",
      "into a diversified financial-services and technology-platform company.",
      "Evaluate member growth, cross-buying, deposits and funding costs, lending volumes and credit quality,",
      "Financial Services monetization, Galileo/Technisys economics, capital requirements, competitive position,",
      "and valuation under bear, base, and bull scenarios.",
    ].join(" ");
  }
  return `Evaluate ${name}'s origins, business model, historical performance, competitive position, key risks, and valuation under bear, base, and bull scenarios.`;
}

async function main() {
  const assetRows = await sql`
    SELECT
      a.id,
      a.canonical_name,
      a.slug,
      a.primary_profile_id,
      rp.version AS profile_version,
      l.symbol
    FROM assets a
    JOIN research_profiles rp ON rp.id = a.primary_profile_id
    LEFT JOIN instruments i ON i.asset_id = a.id
    LEFT JOIN listings l ON l.instrument_id = i.id AND l.is_primary = true
    WHERE LOWER(a.slug) = LOWER(${requestedAsset})
       OR UPPER(l.symbol) = UPPER(${requestedAsset})
    ORDER BY l.is_primary DESC NULLS LAST
    LIMIT 1
  `;
  const asset = assetRows[0];
  if (!asset) {
    throw new Error(`Asset not found for slug or symbol: ${requestedAsset}`);
  }

  const runId = crypto.randomUUID();
  const cutoffAt = process.env.RESEARCH_ACCEPTANCE_CUTOFF_AT || new Date().toISOString();
  const symbol = String(asset.symbol || asset.slug).toUpperCase();
  const researchQuestion =
    process.env.RESEARCH_QUESTION ||
    defaultResearchQuestion(symbol, String(asset.canonical_name));

  console.log(`Creating ${symbol} v${requestedPipelineVersion} run ${runId} with ${acceptanceProvider} provider...`);
  await sql`
    INSERT INTO research_runs (
      id, asset_id, run_type, status, research_question, requested_by,
      profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
      budget_limit_usd, pipeline_version, metadata_json
    ) VALUES (
      ${runId}, ${asset.id}, 'deep_dive', 'pending', ${researchQuestion}, 'system-test-harness',
      ${asset.primary_profile_id}, ${Number(asset.profile_version || 1)}, ${cutoffAt}, ${cutoffAt},
      ${process.env.RESEARCH_ACCEPTANCE_BUDGET_USD || "10.00"}, ${requestedPipelineVersion},
      ${sql.json({
        acceptance_provider: acceptanceProvider,
        cutoff_at_utc: cutoffAt,
        acceptance_asset: symbol,
      })}
    )
  `;

  await sql`
    INSERT INTO asset_profile_assignments (
      asset_id, research_run_id, profile_id, assignment_reason,
      assigned_by, confidence, status
    ) VALUES (
      ${asset.id}, ${runId}, ${asset.primary_profile_id},
      'Run-scoped assignment from the asset primary profile',
      'system-test-harness', '1.0', 'active'
    )
  `;

  await createStagesForRun(runId);

  let result = await runSystemResearchPipeline(runId);
  console.log("Initial result:", JSON.stringify(result, null, 2));

  const [planStage] = await sql`
    SELECT status
    FROM research_stages
    WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
  `;
  if (result.status === "waiting_for_human" && planStage?.status === "waiting_for_human") {
    console.log("Approving the test research-plan gate and resuming...");
    await approveResearchPlan(runId, "system-test-harness");
    result = await runSystemResearchPipeline(runId);
    console.log("Result after plan approval:", JSON.stringify(result, null, 2));
  }

  const [run] = await sql`
    SELECT status, actual_cost_usd, failure_reason, pipeline_version
    FROM research_runs
    WHERE id = ${runId}
  `;
  console.log("Final run:", JSON.stringify({ runId, ...run }, null, 2));
}

main()
  .catch((error) => {
    console.error("Pipeline run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
