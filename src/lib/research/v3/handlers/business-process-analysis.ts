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

export const businessProcessAnalysisHandler: V3StageHandler<unknown> = {
  stageKey: "business_process_analysis",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "business-model-analyst:process-map";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["customer_funnel_mechanics", "segment_economics", "business_process_flow"],
      };

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: ANALYST_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Document segment unit-economics and trace buyer/seller/user acquisition and transaction flow diagrams.",
        ],
      });

      const output = await callV3Agent<Record<string, any>>({
        sql, ctx, stageKey: "business_process_analysis", taskKey,
        taskType: "business_process_analysis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
      });

      // Persist business process sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = [
        "segment_model",
        "customer_decision_map",
        "business_process_map",
        "bottleneck_map",
        "competitive_response_matrix"
      ];
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
          AND (task_key = 'business-model-analyst:process-map' OR task_type = 'business_process_analysis')
          AND status = 'completed'
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No completed business process map found");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
