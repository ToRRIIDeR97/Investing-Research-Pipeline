import {
  executeFrameworkBacktest,
  type FrameworkBenchmarkConfig,
} from "../src/lib/backtesting/framework-runner";
import { generateStrategyCombinations } from "../src/lib/backtesting/framework";
import type { ResearchRunContext } from "../src/lib/research/run-context";
import { CURRENT_PIPELINE_VERSION } from "../src/lib/research/version";

async function main() {
  const cutoff = new Date();
  const symbol = String(process.env.RESEARCH_ASSET || "SOFI").trim().toUpperCase();
  const assetName = String(process.env.RESEARCH_ASSET_NAME || "SoFi Technologies").trim();
  const benchmarkSymbols = String(process.env.RESEARCH_BENCHMARKS || "QQQ,XLF,KRE,SPY")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const benchmarkConfig: FrameworkBenchmarkConfig = {
    symbols: [...new Set(benchmarkSymbols)],
    primaryBenchmark: String(process.env.RESEARCH_PRIMARY_BENCHMARK || benchmarkSymbols[0] || "SPY").toUpperCase(),
    sectorBenchmark: String(process.env.RESEARCH_SECTOR_BENCHMARK || benchmarkSymbols[1] || benchmarkSymbols[0] || "SPY").toUpperCase(),
    broadBenchmark: String(process.env.RESEARCH_BROAD_BENCHMARK || "SPY").toUpperCase(),
  };
  for (const required of [
    benchmarkConfig.primaryBenchmark,
    benchmarkConfig.sectorBenchmark,
    benchmarkConfig.broadBenchmark,
  ]) {
    if (required && !benchmarkConfig.symbols.includes(required)) benchmarkConfig.symbols.push(required);
  }
  const context: ResearchRunContext = {
    runId: `${symbol.toLowerCase()}-live-validation`,
    assetId: "validation-only",
    assetName,
    assetSlug: symbol.toLowerCase(),
    symbol,
    runType: "full_initiation_report",
    pipelineVersion: CURRENT_PIPELINE_VERSION,
    cutoffAt: cutoff,
    marketDataCutoffAt: cutoff,
    profileId: null,
    profileKey: "live-backtest-validation",
    researchQuestion: `Test whether the documented ${assetName} thesis and risk regimes produce robust timing evidence.`,
    budgetLimitUsd: 0,
    budgetSpentUsd: 0,
    budgetRemainingUsd: 0,
    testMode: false,
    syntheticFixtureId: null,
    composedProfile: null,
    archetypeKeys: ["operating_company_core"],
    overlayKeys: [],
    timingHypothesis: null,
  };
  const combinations = generateStrategyCombinations(context.researchQuestion);
  const { result, artifacts } = await executeFrameworkBacktest(
    context,
    combinations,
    benchmarkConfig
  );
  const top = result.rankings[0];
  const statusCounts = Object.fromEntries(
    ["Robust", "Promising", "Needs review", "Weak", "Rejected"].map((status) => [
      status,
      result.rankings.filter((item) => item.status === status).length,
    ])
  );
  console.log(JSON.stringify({
    symbol: context.symbol,
    observations: result.observations,
    data_start: result.dates[0],
    data_end: result.dates.at(-1),
    split_date: result.split_date,
    transaction_cost_bps: result.transaction_cost_bps,
    combinations_tested: result.rankings.length,
    status_counts: statusCounts,
    top: {
      combination_key: top.combination_key,
      strategy_name: top.strategy_name,
      status: top.status,
      final_score: top.final_score,
      cagr: top.metrics.cagr,
      max_drawdown: top.metrics.max_drawdown,
      sharpe: top.metrics.sharpe,
      out_of_sample_return: top.metrics.out_of_sample_return,
      out_of_sample_excess_return: top.metrics.out_of_sample_excess_return,
    },
    artifacts,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
