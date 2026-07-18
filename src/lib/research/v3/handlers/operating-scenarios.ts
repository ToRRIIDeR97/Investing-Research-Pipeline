import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { callV3Agent, v3ExactJsonPrompt } from "../../v3-context";
import { createArtifactRepository } from "../../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const ANALYST_OUTPUT_KEYS = [
  "analysis_sections",
  "key_drivers",
  "metric_interpretation",
  "contradictions_or_tensions",
  "missing_modules",
  "source_gaps",
  "analyst_questions",
  "confidence",
];

export const operatingScenariosHandler: V3StageHandler<unknown> = {
  stageKey: "operating_scenarios",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "forecast-analyst:scenarios";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["scenario_specifications", "bear_base_bull_ranges", "operating_scenarios"],
      };

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: ANALYST_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Establish probabilistic base, bull, and bear scenario assumptions for all forecast drivers.",
        ],
      });

      const output = await callV3Agent<Record<string, any>>({
        sql, ctx, stageKey: "operating_scenarios", taskKey,
        taskType: "operating_scenarios", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
      });

      // Persist operating scenario set artifact
      if (output.operating_scenario_set) {
        const db = drizzle(sql, { schema });
        const repo = createArtifactRepository(db);
        await repo.upsertArtifact({
          research_run_id: ctx.runId,
          asset_id: ctx.assetId,
          profile_id: ctx.profileId || undefined,
          artifact_type: "operating_scenario_set",
          scope_key: `${ctx.assetSlug}-operating-scenario-set`,
          status: "accepted",
          content_json: output.operating_scenario_set,
          schema_version: "3.0.0",
          validator_version: "1.0.0",
          prompt_version: "v3",
          created_by: "system-v3",
          idempotency_key: `${ctx.runId}-operating-scenario-set`,
        });
      }

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT COUNT(*) as cnt FROM research_tasks
        WHERE research_run_id = ${ctx.runId}
          AND (task_key = 'forecast-analyst:scenarios' OR task_type = 'operating_scenarios')
          AND status = 'completed'
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No completed operating scenario set found");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
