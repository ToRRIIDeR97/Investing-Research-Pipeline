import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@/db";
import { MINIMUM_COMBINATION_COUNT } from "@/lib/backtesting/framework";
import { createArtifactRepository } from "../artifacts/repository";
import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";

export const backtestReviewHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "backtest_review",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const runs = await sql`
        SELECT
          sc.combination_key,
          sc.name,
          sc.hypothesis,
          sc.definition_json,
          br.metrics_json
        FROM strategy_combinations sc
        JOIN backtest_runs br ON br.id = sc.backtest_run_id
        WHERE sc.research_run_id = ${ctx.runId}
          AND sc.status = 'completed'
          AND br.status = 'completed'
        ORDER BY (br.metrics_json->>'final_score')::numeric DESC
      `;
      const ranked = runs.map((row, index) => {
        const metrics = row.metrics_json as Record<string, any>;
        return {
          rank: index + 1,
          combination_key: row.combination_key,
          strategy_name: row.name,
          hypothesis: row.hypothesis,
          status: metrics.status,
          final_score: Number(metrics.final_score),
          cagr: Number(metrics.cagr),
          total_return: Number(metrics.total_return),
          max_drawdown: Number(metrics.max_drawdown),
          sharpe: Number(metrics.sharpe),
          sortino: Number(metrics.sortino),
          out_of_sample_return: Number(metrics.out_of_sample_return),
          out_of_sample_excess_return: Number(metrics.out_of_sample_excess_return),
          benchmark_relative_return: Number(metrics.benchmark_relative_return),
          number_of_trades: Number(metrics.number_of_trades),
          parameter_stability: metrics.parameter_stability,
          lead_bucket: metrics.lead_bucket,
        };
      });
      const weakCandidates = ranked.filter((item) => ["Weak", "Rejected"].includes(String(item.status)));
      const weak = [...(weakCandidates.length >= 5 ? weakCandidates : ranked)]
        .sort((a, b) => a.final_score - b.final_score)
        .slice(0, 5)
        .map((item) => ({
          ...item,
          why_it_failed:
            item.number_of_trades < 2 ? "Insufficient trading observations." :
            item.max_drawdown < -0.5 ? "Drawdown exceeded the rejection threshold." :
            item.out_of_sample_return <= 0 ? "Did not survive the out-of-sample period." :
            "Risk-adjusted and benchmark-relative evidence was weak.",
          lesson_for_thesis:
            item.out_of_sample_return <= 0
              ? "The named thesis condition did not generalize out of sample."
              : "The thesis may describe the business without providing a reliable timing signal.",
        }));
      const statusCounts = Object.fromEntries(
        ["Robust", "Promising", "Needs review", "Weak", "Rejected"].map((status) => [
          status,
          ranked.filter((item) => item.status === status).length,
        ])
      );
      const everyCombinationUsesTwoFamilies = runs.every((row) => {
        const definition = row.definition_json as Record<string, any>;
        return new Set(definition.familiesUsed || []).size >= 2;
      });
      const fiveBucketMixComplete = new Set(ranked.map((item) => item.lead_bucket)).size === 5;
      const everyRunHasControls = runs.every((row) => {
        const metrics = row.metrics_json as Record<string, any>;
        return Number(metrics.transaction_cost_bps) > 0
          && Boolean(metrics.split_date)
          && Boolean(metrics.in_sample)
          && Boolean(metrics.out_of_sample)
          && Number.isFinite(Number(metrics.out_of_sample_excess_return))
          && Boolean(metrics.parameter_stability);
      });
      const gatePassed =
        ranked.length >= MINIMUM_COMBINATION_COUNT
        && weak.length >= 5
        && everyCombinationUsesTwoFamilies
        && fiveBucketMixComplete
        && everyRunHasControls;
      const review = {
        artifact_type: "backtest_review",
        framework_gate: {
          minimum_combinations: MINIMUM_COMBINATION_COUNT,
          combinations_tested: ranked.length,
          at_least_two_families_per_combination: everyCombinationUsesTwoFamilies,
          five_bucket_mix_complete: fiveBucketMixComplete,
          source_alignment_disclosed: true,
          no_lookahead_control: "Signals calculated at t were applied at t+1.",
          transaction_costs_included: everyRunHasControls,
          top_ten_reviewed: ranked.slice(0, 10).length === 10,
          weak_or_failed_reviewed: weak.length,
          passed: gatePassed,
        },
        status_counts: statusCounts,
        top_ten: ranked.slice(0, 10),
        weak_or_failed: weak,
        benchmark_conclusion: ranked[0]
          ? {
              beat_asset_buy_and_hold: ranked[0].benchmark_relative_return > 0,
              positive_out_of_sample_excess_return: ranked[0].out_of_sample_excess_return > 0,
              beat_cash_after_costs: ranked[0].total_return > 0,
              basis: "The leader was ranked on in-sample metrics only. beat_asset_buy_and_hold and beat_cash_after_costs cover the full period (in-sample and out-of-sample); positive_out_of_sample_excess_return covers only the held-out period.",
            }
          : null,
        supported_conclusion: gatePassed
          ? "The backtest is admissible as risk/timing evidence, subject to the disclosed proxy-data limitations."
          : "Conclusion withheld - research incomplete.",
        unsupported_conclusion: "Backtesting does not prove the fundamental investment thesis or remove the need for point-in-time fundamental and external datasets.",
        next_robustness_test: "Replace cautious proxy indicators with true release-date-aligned filing, macro, industry, and asset-specific histories.",
      };

      const repo = createArtifactRepository(drizzle(sql, { schema }));
      await repo.upsertArtifact({
        research_run_id: ctx.runId,
        asset_id: ctx.assetId,
        profile_id: ctx.profileId || undefined,
        artifact_type: "backtest_review",
        scope_key: `${ctx.assetSlug}-backtest-review`,
        status: gatePassed ? "validated" : "draft",
        content_json: review,
        schema_version: "1.0.0",
        validator_version: "1.0.0",
        prompt_version: "deterministic-framework-v1",
        created_by: "system-research-os",
      });
      return review;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: Record<string, any>): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!output?.framework_gate?.passed) {
      errors.push("Conclusion withheld - the 50-combination backtest gate did not pass.");
    }
    if (!Array.isArray(output?.top_ten) || output.top_ten.length < 10) {
      errors.push("Top 10 strategy review is incomplete.");
    }
    if (!Array.isArray(output?.weak_or_failed) || output.weak_or_failed.length < 5) {
      errors.push("At least five weak or failed combinations must be reviewed.");
    }
    return makeValidationResult(errors);
  },
};
