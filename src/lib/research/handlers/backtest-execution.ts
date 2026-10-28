import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@/db";
import {
  InsufficientBacktestHistory,
  MINIMUM_COMBINATION_COUNT,
  type StrategyCombination,
} from "@/lib/backtesting/framework";
import { executeFrameworkBacktest, frameworkBenchmarks } from "@/lib/backtesting/framework-runner";
import { createArtifactRepository } from "../artifacts/repository";
import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";

export const backtestExecutionHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "backtest_execution",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT definition_json
        FROM strategy_combinations
        WHERE research_run_id = ${ctx.runId}
        ORDER BY combination_key
      `;
      const combinations = rows.map((row) => row.definition_json as StrategyCombination);
      if (combinations.length < MINIMUM_COMBINATION_COUNT) {
        throw new Error(`Conclusion withheld - only ${combinations.length}/${MINIMUM_COMBINATION_COUNT} combinations are available.`);
      }

      const [asset] = await sql`SELECT sector FROM assets WHERE id = ${ctx.assetId}`;
      const benchmarks = frameworkBenchmarks(asset?.sector, ctx.archetypeKeys.includes("bank"));
      const clearEarlierAttempt = async (tx: postgres.TransactionSql) => {
        const oldRuns = await tx`
          SELECT id FROM backtest_runs WHERE research_run_id = ${ctx.runId}
        `;
        if (oldRuns.length) {
          await tx`
            UPDATE strategy_combinations
            SET backtest_run_id = NULL, status = 'proposed', completed_at = NULL
            WHERE research_run_id = ${ctx.runId}
          `;
          await tx`
            DELETE FROM backtest_artifacts
            WHERE research_run_id = ${ctx.runId}
          `;
          await tx`
            DELETE FROM backtest_runs
            WHERE research_run_id = ${ctx.runId}
          `;
        }
      };
      // Drizzle replaces this client's date serializers, so the repository is created only after the raw writes.
      const repository = () => createArtifactRepository(drizzle(sql, { schema }));
      let execution: Awaited<ReturnType<typeof executeFrameworkBacktest>>;
      try {
        execution = await executeFrameworkBacktest(ctx, combinations, benchmarks);
      } catch (error) {
        if (!(error instanceof InsufficientBacktestHistory)) throw error;
        // Too little aligned history is a data limit, not a failure: record the backtest as withheld
        // and skip its review, so the run continues without timing evidence.
        const reason = `Backtest withheld: ${error.message}`;
        await sql.begin(async (tx) => {
          await clearEarlierAttempt(tx);
          await tx`
            UPDATE research_stages SET status = 'skipped', failure_reason = ${reason}, updated_at = NOW()
            WHERE research_run_id = ${ctx.runId} AND stage_key = 'backtest_review' AND status = 'pending'
          `;
        });
        await repository().upsertArtifact({
          research_run_id: ctx.runId,
          asset_id: ctx.assetId,
          profile_id: ctx.profileId || undefined,
          artifact_type: "backtest_execution_summary",
          scope_key: `${ctx.assetSlug}-backtest-execution`,
          status: "validated",
          content_json: {
            artifact_type: "backtest_execution_summary", status: "withheld", withheld_reason: reason,
            combinations_executed: 0, benchmarks: benchmarks.symbols, sector_benchmark: benchmarks.sectorBenchmark,
          },
          schema_version: "1.0.0",
          validator_version: "1.0.0",
          prompt_version: "deterministic-framework-v1",
          created_by: "system-research-os",
        });
        return { withheld: reason, combinations_executed: 0 };
      }
      const { result, dataset, artifacts } = execution;

      await sql.begin(async (tx) => {
        await clearEarlierAttempt(tx);
        // An earlier attempt that withheld the backtest skipped its review; this one has results to review.
        await tx`
          UPDATE research_stages SET status = 'pending', failure_reason = NULL, updated_at = NOW()
          WHERE research_run_id = ${ctx.runId} AND stage_key = 'backtest_review' AND status = 'skipped'
            AND failure_reason LIKE 'Backtest withheld:%'
        `;

        const runIds = new Map<string, string>();
        for (const ranked of result.rankings) {
          const definition = combinations.find((item) => item.combinationKey === ranked.combination_key);
          if (!definition) throw new Error(`Missing definition for ${ranked.combination_key}.`);
          const [inserted] = await tx`
            INSERT INTO backtest_runs (
              research_run_id, asset_id, status, strategy_name, strategy_prompt,
              symbol, benchmark_symbol, data_provider, start_date, end_date,
              market_data_cutoff_at, initial_capital, params_json, assumptions_json,
              metrics_json, started_at, completed_at
            ) VALUES (
              ${ctx.runId}, ${ctx.assetId}, 'completed', ${ranked.strategy_name},
              ${definition.hypothesis}, ${ctx.symbol}, ${dataset.primaryBenchmark},
              ${dataset.source}, ${result.dates[0]}, ${result.dates.at(-1) || result.dates[0]},
              ${ctx.marketDataCutoffAt}, '100000',
              ${tx.json({
                combination_key: ranked.combination_key,
                entry_rule: definition.entryRule,
                exit_rule: definition.exitRule,
                risk_control: definition.riskControl,
                position_sizing: definition.positionSizing,
              })},
              ${tx.json([
                { transaction_cost_bps: result.transaction_cost_bps },
                { split_ratio: result.split_ratio, split_date: result.split_date },
                { no_lookahead: "Signals calculated at t are applied to returns at t+1." },
                { benchmarks: { primary: dataset.primaryBenchmark, sector: dataset.sectorBenchmark, broad: dataset.broadBenchmark } },
                { data_limitations: result.source_alignment },
              ])},
              ${tx.json({
                ...ranked.metrics,
                status: ranked.status,
                final_score: ranked.final_score,
                lead_bucket: ranked.lead_bucket,
                indicators_used: ranked.indicators_used,
                families_used: ranked.families_used,
                benchmark_metrics: result.benchmark_metrics,
              } as any)},
              NOW(), NOW()
            )
            RETURNING id
          `;
          runIds.set(ranked.combination_key, String(inserted.id));
          await tx`
            UPDATE strategy_combinations
            SET status = 'completed',
                backtest_run_id = ${inserted.id},
                completed_at = NOW()
            WHERE research_run_id = ${ctx.runId}
              AND combination_key = ${ranked.combination_key}
          `;
        }

        const bestRunId = runIds.get(result.rankings[0].combination_key);
        if (!bestRunId) throw new Error("Backtest ranking did not produce a best run.");
        for (const artifact of artifacts) {
          await tx`
            INSERT INTO backtest_artifacts (
              backtest_run_id, research_run_id, artifact_type, title,
              storage_path, mime_type, metadata_json
            ) VALUES (
              ${bestRunId}, ${ctx.runId}, ${artifact.artifact_type}, ${artifact.title},
              ${artifact.storage_path}, ${artifact.mime_type}, ${tx.json(artifact.metadata_json as any)}
            )
          `;
        }

        const latestIndex = result.dates.length - 1;
        for (const [indicatorKey, values] of Object.entries(result.indicators)) {
          const [definition] = await tx`
            SELECT id FROM indicator_definitions
            WHERE research_run_id = ${ctx.runId}
              AND indicator_key = ${indicatorKey}
          `;
          if (!definition) continue;
          await tx`
            DELETE FROM indicator_observations
            WHERE indicator_definition_id = ${definition.id}
          `;
          const value = values[latestIndex];
          await tx`
            INSERT INTO indicator_observations (
              indicator_definition_id, observed_at, available_at,
              value_numeric, input_observation_ids, metadata_json
            ) VALUES (
              ${definition.id}, ${result.dates[latestIndex]}, ${result.dates[latestIndex]},
              ${value == null ? null : value.toString()}, ARRAY[]::uuid[],
              ${tx.json({
                source: dataset.source,
                point_in_time: true,
                full_series_artifact: artifacts.find((item) => item.artifact_type === "combo_rankings")?.storage_path,
              })}
            )
          `;
        }
      });

      await repository().upsertArtifact({
        research_run_id: ctx.runId,
        asset_id: ctx.assetId,
        profile_id: ctx.profileId || undefined,
        artifact_type: "backtest_execution_summary",
        scope_key: `${ctx.assetSlug}-backtest-execution`,
        status: "validated",
        content_json: {
          artifact_type: "backtest_execution_summary",
          combinations_executed: result.rankings.length,
          observations: result.observations,
          data_start: result.dates[0],
          data_end: result.dates.at(-1),
          in_sample_split: result.split_date,
          transaction_cost_bps: result.transaction_cost_bps,
          benchmarks: Object.keys(result.benchmark_metrics),
          sector_benchmark: dataset.sectorBenchmark,
          no_lookahead_rule: "Signals calculated at t are applied to returns at t+1.",
          artifacts,
          source_alignment: result.source_alignment,
        },
        schema_version: "1.0.0",
        validator_version: "1.0.0",
        prompt_version: "deterministic-framework-v1",
        created_by: "system-research-os",
      });
      return {
        combinations_executed: result.rankings.length,
        top_combination: result.rankings[0].combination_key,
        artifacts: artifacts.length,
      };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output?: Record<string, unknown>): Promise<ValidationResult> {
    // A withheld backtest wrote its summary and skipped backtest_review; there are no runs to check.
    if (output?.withheld) return makeValidationResult([], [String(output.withheld)]);
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const [counts] = await sql`
        SELECT
          COUNT(*) FILTER (WHERE br.status = 'completed') AS completed_runs,
          COUNT(*) FILTER (
            WHERE br.metrics_json ? 'in_sample'
              AND br.metrics_json ? 'out_of_sample'
              AND br.metrics_json ? 'out_of_sample_excess_return'
              AND br.metrics_json ? 'parameter_stability'
          ) AS robust_results
        FROM backtest_runs br
        WHERE br.research_run_id = ${ctx.runId}
      `;
      const [artifactCount] = await sql`
        SELECT COUNT(*) AS count
        FROM backtest_artifacts
        WHERE research_run_id = ${ctx.runId}
      `;
      const errors: string[] = [];
      if (Number(counts?.completed_runs || 0) < MINIMUM_COMBINATION_COUNT) {
        errors.push(`Only ${counts?.completed_runs || 0}/${MINIMUM_COMBINATION_COUNT} backtests completed.`);
      }
      if (Number(counts?.robust_results || 0) < MINIMUM_COMBINATION_COUNT) {
        errors.push("Not all combinations contain in-sample, out-of-sample, excess-return, and stability results.");
      }
      if (Number(artifactCount?.count || 0) < 5) {
        errors.push("Backtest output table and chart artifacts are incomplete.");
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  },
};
