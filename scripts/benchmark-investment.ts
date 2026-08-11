import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { scoreBenchmark } from "../src/lib/investment-benchmark/scoring";
import type { BenchmarkCase, BenchmarkOutcome, BenchmarkPrediction } from "../src/lib/investment-benchmark/types";
import { createResearchRunWithStages } from "../src/lib/research/run-service";

type Manifest = { campaignId: string; version: number; cases: BenchmarkCase[] };

const CIK_BY_SYMBOL: Record<string, string> = {
  MSFT: "0000789019", ADBE: "0000796343", CRM: "0001108524", ORCL: "0001341439",
  AMZN: "0001018724", META: "0001326801", MELI: "0001099590", PYPL: "0001633917",
  JPM: "0000019617", BAC: "0000070858", SOFI: "0001818874", COF: "0000927628",
  CAT: "0000018230", UPS: "0001090727", NKE: "0000320187", COST: "0000909832",
  XOM: "0000034088", FCX: "0000831259", "BRK.B": "0001067983", IAC: "0000105016",
};

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(resolve(file), "utf8")) as T;
}

async function createOrdinaryRuns(campaignPath: string, campaign: {
  campaignId: string;
  budgetUsd: number;
  cases: Array<BenchmarkCase & { researchRunId?: string | null; status?: string; error?: string }>;
  predictions: BenchmarkPrediction[];
  outcomes: BenchmarkOutcome[];
}) {
  if (!process.env.DATABASE_URL) return false;
  const sql = postgres(process.env.DATABASE_URL);
  try {
    for (const item of campaign.cases) {
      if (item.researchRunId) continue;
      const assets = await sql`
        SELECT a.id
        FROM assets a
        LEFT JOIN instruments i ON i.asset_id = a.id
        LEFT JOIN listings l ON l.instrument_id = i.id AND l.active_to IS NULL
        WHERE lower(a.slug) = lower(${item.symbol}) OR lower(l.symbol) = lower(${item.symbol})
        ORDER BY l.is_primary DESC NULLS LAST
        LIMIT 1
      `;
      if (!assets[0]) {
        item.status = "blocked";
        item.error = `Benchmark asset is not registered: ${item.symbol}`;
        await writeFile(resolve(campaignPath), `${JSON.stringify(campaign, null, 2)}\n`);
        throw new Error(item.error);
      }
      const researchQuestion = `Frozen investment benchmark case ${item.caseId}`;
      const cutoff = new Date(`${item.asOfDate}T23:59:59.999Z`);
      const existingRuns = await sql`
        SELECT id
        FROM research_runs
        WHERE asset_id = ${assets[0].id}
          AND requested_by = 'investment-benchmark-v1'
          AND research_question = ${researchQuestion}
          AND source_cutoff_at = ${cutoff}
          AND market_data_cutoff_at = ${cutoff}
        ORDER BY created_at ASC
        LIMIT 1
      `;
      if (existingRuns[0]) {
        item.researchRunId = String(existingRuns[0].id);
        item.status = "run_created";
        await writeFile(resolve(campaignPath), `${JSON.stringify(campaign, null, 2)}\n`);
        continue;
      }
      const run = await createResearchRunWithStages({
        assetId: String(assets[0].id),
        runType: "full_initiation_report",
        researchQuestion,
        requestedBy: "investment-benchmark-v1",
        profileId: null,
        profileVersion: null,
        budgetLimitUsd: campaign.budgetUsd / campaign.cases.length,
        sourceCutoffAt: cutoff,
        marketDataCutoffAt: cutoff,
      });
      item.researchRunId = String(run.id);
      item.status = "run_created";
      await writeFile(resolve(campaignPath), `${JSON.stringify(campaign, null, 2)}\n`);
    }
    return true;
  } finally {
    await sql.end();
  }
}

function validateManifest(manifest: Manifest) {
  if (!manifest.campaignId || manifest.version !== 1 || !Array.isArray(manifest.cases)) {
    throw new Error("Benchmark manifest must contain campaignId, version 1, and cases");
  }
  const ids = new Set<string>();
  for (const item of manifest.cases) {
    if (ids.has(item.caseId)) throw new Error(`Duplicate benchmark case: ${item.caseId}`);
    ids.add(item.caseId);
    if (!item.yahooSymbol || !item.asOfDate || !item.benchmarkSymbol || !item.sectorBenchmarkSymbol) {
      throw new Error(`Incomplete benchmark case: ${item.caseId}`);
    }
    if (!CIK_BY_SYMBOL[item.symbol] && !item.cik) throw new Error(`No frozen CIK mapping for ${item.symbol}`);
  }
  if (manifest.cases.length !== 40) throw new Error(`V1 benchmark manifest must contain 40 cases, got ${manifest.cases.length}`);
}

async function main() {
  const [, , command, ...args] = process.argv;
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (!command || !["prepare", "run", "score"].includes(command)) {
    throw new Error("Usage: benchmark-investment.ts <prepare|run|score> --manifest <path> [--budget-usd <amount>] [--campaign <path>]");
  }

  if (command === "score") {
    const campaignPath = value("--campaign");
    if (!campaignPath) throw new Error("score requires --campaign");
    const campaign = await loadJson<{
      campaignId: string;
      cases: BenchmarkCase[];
      predictions: BenchmarkPrediction[];
      outcomes: BenchmarkOutcome[];
    }>(campaignPath);
    const report = scoreBenchmark(campaign.campaignId, campaign.cases, campaign.predictions, campaign.outcomes);
    const outputDir = dirname(resolve(campaignPath));
    await writeFile(resolve(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(resolve(outputDir, "report.md"), [
      `# ${report.campaignId}`,
      "",
      `Status: **${report.status}** (${report.validCases}/${report.totalCases} valid cases)`,
      "",
      "## 12-month metrics",
      "",
      ...Object.entries(report.metrics).map(([key, metric]) => `- ${key}: ${metric === null ? "n/a" : metric}`),
      "",
      "Performance is measured, not automatically interpreted as alpha.",
      "",
    ].join("\n"));
    return;
  }

  const manifestPath = value("--manifest");
  if (!manifestPath) throw new Error(`${command} requires --manifest`);
  const manifest = await loadJson<Manifest>(manifestPath);
  validateManifest(manifest);
  const outputDir = resolve("storage", "evaluations", manifest.campaignId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (command === "prepare") {
    await writeFile(resolve(outputDir, "prepared.json"), `${JSON.stringify({
      campaignId: manifest.campaignId,
      status: "prepared",
      pipelineVersion: 4,
      promptVersion: "v4-runtime-v1",
      validatorVersion: "2.0.0",
      registryVersion: "agent-registry-v4",
      sourceCutoffPolicy: "filed_or_available_at_on_or_before_case_date",
      marketDataCutoffPolicy: "available_at_on_or_before_case_date",
      cases: manifest.cases.map((item) => ({
        ...item,
        cik: item.cik || CIK_BY_SYMBOL[item.symbol],
        sourceCutoffAt: `${item.asOfDate}T23:59:59.999Z`,
        marketDataCutoffAt: `${item.asOfDate}T23:59:59.999Z`,
        status: "pending",
        researchRunId: null,
      })),
    }, null, 2)}\n`);
    console.log(`Prepared ${manifest.cases.length} benchmark cases at ${outputDir}`);
    return;
  }

  const budget = Number(value("--budget-usd"));
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("run requires a positive --budget-usd; execution is never implicit");
  const campaignFile = resolve(outputDir, "campaign.json");
  try {
    const existing = await loadJson<{
      campaignId: string;
      budgetUsd: number;
      cases: Array<BenchmarkCase & { researchRunId?: string | null; status?: string; error?: string }>;
      predictions: BenchmarkPrediction[];
      outcomes: BenchmarkOutcome[];
    }>(campaignFile);
    if (existing.campaignId === manifest.campaignId) {
      await createOrdinaryRuns(campaignFile, existing);
      console.log(`Resuming existing campaign: ${campaignFile}`);
      return;
    }
  } catch {
    // First execution creates the resumable campaign below.
  }
  await writeFile(campaignFile, `${JSON.stringify({
    campaignId: manifest.campaignId,
    budgetUsd: budget,
    status: "ready_for_execution",
    execution: "deferred_until_provider_and_database_are_configured",
    cases: manifest.cases.map((item) => ({
      ...item,
      cik: item.cik || CIK_BY_SYMBOL[item.symbol],
      sourceCutoffAt: `${item.asOfDate}T23:59:59.999Z`,
      marketDataCutoffAt: `${item.asOfDate}T23:59:59.999Z`,
      researchRunId: null,
      status: "pending",
    })),
    predictions: [],
    outcomes: [],
  }, null, 2)}\n`);
  const campaign = await loadJson<{
    campaignId: string;
    budgetUsd: number;
    cases: Array<BenchmarkCase & { researchRunId?: string | null; status?: string; error?: string }>;
    predictions: BenchmarkPrediction[];
    outcomes: BenchmarkOutcome[];
  }>(campaignFile);
  const runsCreated = await createOrdinaryRuns(campaignFile, campaign);
  console.log(runsCreated
    ? `Campaign and ordinary research runs prepared: ${campaignFile}`
    : `Campaign prepared for explicit execution: ${campaignFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
