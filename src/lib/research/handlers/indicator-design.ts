import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@/db";
import {
  INDICATOR_CATALOG,
  MINIMUM_INDICATOR_COUNT,
} from "@/lib/backtesting/framework";
import { createArtifactRepository } from "../artifacts/repository";
import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";

export const indicatorDesignHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "indicator_design",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    if (!ctx.profileId) throw new Error("Indicator design requires an assigned research profile.");
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      for (const definition of INDICATOR_CATALOG) {
        await sql`
          INSERT INTO indicator_definitions (
            research_run_id, profile_id, indicator_key, name, family, hypothesis,
            calculation_json, input_metric_ids, supporting_claim_ids,
            lookahead_risk, backtestability, status
          ) VALUES (
            ${ctx.runId}, ${ctx.profileId}, ${definition.key}, ${definition.name},
            ${definition.family}, ${definition.hypothesis},
            ${sql.json({
              formula: definition.calculation,
              source: definition.source,
              update_frequency: definition.updateFrequency,
              expected_use: definition.expectedUse,
              failure_condition: definition.failureCondition,
            })},
            ARRAY[]::uuid[], ARRAY[]::uuid[], ${definition.lookaheadRisk},
            ${definition.backtestability}, 'accepted'
          )
          ON CONFLICT (research_run_id, indicator_key) DO UPDATE SET
            name = EXCLUDED.name,
            family = EXCLUDED.family,
            hypothesis = EXCLUDED.hypothesis,
            calculation_json = EXCLUDED.calculation_json,
            lookahead_risk = EXCLUDED.lookahead_risk,
            backtestability = EXCLUDED.backtestability,
            status = 'accepted'
        `;
      }

      const repo = createArtifactRepository(drizzle(sql, { schema }));
      await repo.upsertArtifact({
        research_run_id: ctx.runId,
        asset_id: ctx.assetId,
        profile_id: ctx.profileId,
        artifact_type: "indicator_catalog",
        scope_key: `${ctx.assetSlug}-indicator-catalog`,
        status: "validated",
        content_json: {
          minimum_required: MINIMUM_INDICATOR_COUNT,
          count: INDICATOR_CATALOG.length,
          indicators: INDICATOR_CATALOG,
          rule: "Every indicator is tied to a named hypothesis and discloses source, lookahead risk, backtestability, expected use, and failure conditions.",
        },
        schema_version: "1.0.0",
        validator_version: "1.0.0",
        prompt_version: "deterministic-framework-v1",
        created_by: "system-research-os",
        idempotency_key: `${ctx.runId}-indicator-catalog`,
      });
      return { indicator_count: INDICATOR_CATALOG.length };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const [row] = await sql`
        SELECT COUNT(*) AS count,
               COUNT(DISTINCT family) AS families,
               COUNT(*) FILTER (WHERE status = 'accepted') AS accepted
        FROM indicator_definitions
        WHERE research_run_id = ${ctx.runId}
      `;
      const errors: string[] = [];
      if (Number(row?.count || 0) < MINIMUM_INDICATOR_COUNT) {
        errors.push(`Only ${row?.count || 0}/${MINIMUM_INDICATOR_COUNT} indicators were designed.`);
      }
      if (Number(row?.accepted || 0) < MINIMUM_INDICATOR_COUNT) {
        errors.push("Fewer than 10 indicator definitions were accepted.");
      }
      if (Number(row?.families || 0) < 5) {
        errors.push("Indicator catalog must span at least five indicator families.");
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  },
};
