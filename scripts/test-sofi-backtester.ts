import { executeFrameworkBacktest } from "../src/lib/backtesting/framework-runner";
import { generateStrategyCombinations } from "../src/lib/backtesting/framework";
import type { ResearchRunContext } from "../src/lib/research/run-context";

async function main() {
  const cutoff = new Date();
  const context: ResearchRunContext = {
    runId: "sofi-live-validation",
    assetId: "validation-only",
    assetName: "SoFi Technologies",
    assetSlug: "sofi",
    symbol: "SOFI",
    runType: "full_initiation_report",
    pipelineVersion: 3,
    cutoffAt: cutoff,
    marketDataCutoffAt: cutoff,
    profileId: null,
    profileKey: "fintech-platform",
    researchQuestion: "Test whether SOFI thesis and risk regimes produce robust timing evidence.",
    budgetLimitUsd: 0,
    budgetSpentUsd: 0,
    budgetRemainingUsd: 0,
    testMode: false,
    syntheticFixtureId: null,
    composedProfile: null,
    archetypeKeys: ["operating_company_core", "lender", "payments_network"],
    overlayKeys: [],
    timingHypothesis: null,
  };
  const combinations = generateStrategyCombinations(context.researchQuestion);
  const { result, artifacts } = await executeFrameworkBacktest(context, combinations);
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
