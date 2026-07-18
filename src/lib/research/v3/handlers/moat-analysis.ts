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

export const moatAnalysisHandler: V3StageHandler<unknown> = {
  stageKey: "moat_analysis",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "moat-analyst:assessment";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["moat_durability", "competitive_advantage_sources"],
      };

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: ANALYST_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Assess moat sources: network effects, high switching costs, cost advantages, intangible assets.",
        ],
      });

      const output = await callV3Agent<Record<string, any>>({
        sql, ctx, stageKey: "moat_analysis", taskKey,
        taskType: "moat_analysis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
      });

      // Persist moat sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = ["moat_assessment", "moat_attack_matrix", "no_moat_counterfactual"];
      for (const k of subKeys) {
        if (output[k]) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "accepted",
            content_json: output[k],
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "v3",
            created_by: "system-v3",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
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
          AND (task_key = 'moat-analyst:assessment' OR task_type = 'moat_analysis')
          AND status = 'completed'
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No completed moat assessment found");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
