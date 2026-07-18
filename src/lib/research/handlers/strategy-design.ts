import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@/db";
import {
  generateStrategyCombinations,
  MINIMUM_COMBINATION_COUNT,
  validateStrategyCombinations,
} from "@/lib/backtesting/framework";
import { createArtifactRepository } from "../artifacts/repository";
import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";

export const strategyDesignHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "strategy_design",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const combinations = generateStrategyCombinations(ctx.researchQuestion || ctx.assetName);
      validateStrategyCombinations(combinations);
      for (const combination of combinations) {
        await sql`
          INSERT INTO strategy_combinations (
            research_run_id, combination_key, name, hypothesis,
            definition_json, status
          ) VALUES (
            ${ctx.runId}, ${combination.combinationKey}, ${combination.name},
            ${combination.hypothesis}, ${sql.json(combination as any)}, 'proposed'
          )
          ON CONFLICT (research_run_id, combination_key) DO UPDATE SET
            name = EXCLUDED.name,
            hypothesis = EXCLUDED.hypothesis,
            definition_json = EXCLUDED.definition_json,
            status = CASE
              WHEN strategy_combinations.status = 'completed' THEN 'completed'
              ELSE 'proposed'
            END
        `;
      }

      const repo = createArtifactRepository(drizzle(sql, { schema }));
      await repo.upsertArtifact({
        research_run_id: ctx.runId,
        asset_id: ctx.assetId,
        profile_id: ctx.profileId || undefined,
        artifact_type: "strategy_combination_catalog",
        scope_key: `${ctx.assetSlug}-strategy-combination-catalog`,
        status: "validated",
        content_json: {
          minimum_required: MINIMUM_COMBINATION_COUNT,
          count: combinations.length,
          bucket_counts: Object.fromEntries(
            [...new Set(combinations.map((item) => item.leadBucket))].map((bucket) => [
              bucket,
              combinations.filter((item) => item.leadBucket === bucket).length,
            ])
          ),
          combinations,
          conclusion_gate: "Backtest and review must execute, rank, and review all 50 combinations before the final decision.",
        },
        schema_version: "1.0.0",
        validator_version: "1.0.0",
        prompt_version: "deterministic-framework-v1",
        created_by: "system-research-os",
        idempotency_key: `${ctx.runId}-strategy-combination-catalog`,
      });
      return { combination_count: combinations.length };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT definition_json
        FROM strategy_combinations
        WHERE research_run_id = ${ctx.runId}
        ORDER BY combination_key
      `;
      const errors: string[] = [];
      if (rows.length < MINIMUM_COMBINATION_COUNT) {
        errors.push(`Only ${rows.length}/${MINIMUM_COMBINATION_COUNT} combinations were generated.`);
      } else {
        try {
          validateStrategyCombinations(rows.map((row) => row.definition_json as any));
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  },
};
