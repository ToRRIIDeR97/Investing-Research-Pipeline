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

export const historicalDiagnosisHandler: V3StageHandler<unknown> = {
  stageKey: "historical_diagnosis",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "historical-diagnostician:diagnosis";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["historical_performance_diagnosis", "level_shifts", "historical_inflections"],
      };

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: ANALYST_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Perform a rigorous statistical level-shift and growth inflection analysis of the twenty-quarter historical record.",
        ],
      });

      const output = await callV3Agent<Record<string, any>>({
        sql, ctx, stageKey: "historical_diagnosis", taskKey,
        taskType: "historical_diagnosis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
      });

      // Persist historical_diagnosis artifact
      if (output.historical_diagnosis) {
        const db = drizzle(sql, { schema });
        const repo = createArtifactRepository(db);
        await repo.upsertArtifact({
          research_run_id: ctx.runId,
          asset_id: ctx.assetId,
          profile_id: ctx.profileId || undefined,
          artifact_type: "historical_diagnosis",
          scope_key: `${ctx.assetSlug}-historical-diagnosis`,
          status: "accepted",
          content_json: output.historical_diagnosis,
          schema_version: "3.0.0",
          validator_version: "1.0.0",
          prompt_version: "v3",
          created_by: "system-v3",
          idempotency_key: `${ctx.runId}-historical-diagnosis`,
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
          AND (task_key = 'historical-diagnostician:diagnosis' OR task_type = 'historical_diagnosis')
          AND status = 'completed'
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No completed historical diagnosis artifact found");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
