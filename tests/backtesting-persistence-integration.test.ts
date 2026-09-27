import { describe, it } from "node:test";
import assert from "node:assert";
import postgres from "postgres";
import { createStagesForRun } from "@/lib/workflow/orchestrator";
import { loadRunContext } from "@/lib/research/run-context";
import { indicatorDesignHandler } from "@/lib/research/handlers/indicator-design";
import { strategyDesignHandler } from "@/lib/research/handlers/strategy-design";
import { backtestExecutionHandler } from "@/lib/research/handlers/backtest-execution";
import { backtestReviewHandler } from "@/lib/research/handlers/backtest-review";

const runIntegration = process.env.RUN_DB_INTEGRATION === "1";

describe("SOFI framework backtest persistence", { skip: !runIntegration }, () => {
  it("persists 10+ indicators, 50 completed combinations, artifacts, and a passing review gate", async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const runId = crypto.randomUUID();
    const priorTestMode = process.env.RESEARCH_TEST_MODE;
    process.env.RESEARCH_TEST_MODE = "1";
    try {
      const [asset] = await sql`
        SELECT a.id, a.primary_profile_id, rp.version AS profile_version
        FROM assets a
        JOIN research_profiles rp ON rp.id = a.primary_profile_id
        LEFT JOIN instruments i ON i.asset_id = a.id
        LEFT JOIN listings l ON l.instrument_id = i.id AND l.active_to IS NULL
        WHERE LOWER(a.slug) = 'sofi' OR UPPER(l.symbol) = 'SOFI'
        ORDER BY l.is_primary DESC NULLS LAST
        LIMIT 1
      `;
      assert.ok(asset, "SOFI must be seeded before running this integration test.");
      const cutoff = "2024-10-30T00:00:00Z";
      await sql`
        INSERT INTO research_runs (
          id, asset_id, run_type, status, research_question, requested_by,
          profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
          budget_limit_usd, pipeline_version, metadata_json
        ) VALUES (
          ${runId}, ${asset.id}, 'full_initiation_report', 'running',
          'Test SOFI member growth, funding, credit, technology-platform, valuation, and risk-regime hypotheses.',
          'backtest-integration', ${asset.primary_profile_id}, ${Number(asset.profile_version || 1)},
          ${cutoff}, ${cutoff}, '0', 3,
          ${sql.json({
            v3_archetypes: ["operating_company_core", "lender", "payments_network"],
            v3_overlays: [],
            synthetic_fixture_id: "sofi-backtest-persistence",
          })}
        )
      `;
      await createStagesForRun(runId);
      const ctx = await loadRunContext(sql, runId);

      const indicatorOutput = await indicatorDesignHandler.execute(ctx);
      assert.equal((await indicatorDesignHandler.validate!(ctx, indicatorOutput)).valid, true);
      const strategyOutput = await strategyDesignHandler.execute(ctx);
      assert.equal((await strategyDesignHandler.validate!(ctx, strategyOutput)).valid, true);
      const executionOutput = await backtestExecutionHandler.execute(ctx);
      assert.equal((await backtestExecutionHandler.validate!(ctx, executionOutput)).valid, true);
      const reviewOutput = await backtestReviewHandler.execute(ctx);
      assert.equal((await backtestReviewHandler.validate!(ctx, reviewOutput)).valid, true);

      const [counts] = await sql`
        SELECT
          (SELECT COUNT(*) FROM indicator_definitions WHERE research_run_id = ${runId}) AS indicators,
          (SELECT COUNT(*) FROM strategy_combinations WHERE research_run_id = ${runId} AND status = 'completed') AS combinations,
          (SELECT COUNT(*) FROM backtest_runs WHERE research_run_id = ${runId} AND status = 'completed') AS backtests,
          (SELECT COUNT(*) FROM backtest_artifacts WHERE research_run_id = ${runId}) AS backtest_artifacts
      `;
      assert.ok(Number(counts.indicators) >= 10);
      assert.equal(Number(counts.combinations), 50);
      assert.equal(Number(counts.backtests), 50);
      assert.ok(Number(counts.backtest_artifacts) >= 5);

      const [review] = await sql`
        SELECT content_json
        FROM research_artifacts
        WHERE research_run_id = ${runId}
          AND artifact_type = 'backtest_review'
          AND status = 'validated'
      `;
      assert.equal(review.content_json.framework_gate.passed, true);
      assert.equal(review.content_json.top_ten.length, 10);
      assert.equal(review.content_json.weak_or_failed.length, 5);
    } finally {
      await sql`
        DELETE FROM indicator_observations
        WHERE indicator_definition_id IN (
          SELECT id FROM indicator_definitions WHERE research_run_id = ${runId}
        )
      `.catch(() => undefined);
      await sql`DELETE FROM indicator_definitions WHERE research_run_id = ${runId}`.catch(() => undefined);
      await sql`
        UPDATE strategy_combinations
        SET backtest_run_id = NULL
        WHERE research_run_id = ${runId}
      `.catch(() => undefined);
      await sql`DELETE FROM strategy_combinations WHERE research_run_id = ${runId}`.catch(() => undefined);
      await sql`DELETE FROM backtest_artifacts WHERE research_run_id = ${runId}`.catch(() => undefined);
      await sql`DELETE FROM backtest_runs WHERE research_run_id = ${runId}`.catch(() => undefined);
      await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`.catch(() => undefined);
      await sql`DELETE FROM research_stages WHERE research_run_id = ${runId}`.catch(() => undefined);
      await sql`DELETE FROM research_runs WHERE id = ${runId}`.catch(() => undefined);
      await sql.end();
      if (priorTestMode == null) delete process.env.RESEARCH_TEST_MODE;
      else process.env.RESEARCH_TEST_MODE = priorTestMode;
    }
  });
});
