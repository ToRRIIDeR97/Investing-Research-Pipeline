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

export const companyGenesisHandler: V3StageHandler<unknown> = {
  stageKey: "company_genesis",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = `genesis-researcher:${ctx.symbol?.toLowerCase() || "asset"}-genesis`;
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["founder_and_company_history", "corporate_structure"],
      };

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: ANALYST_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Provide a detailed synthesis of the company genesis, founders, and early corporate structure.",
          "Link analysis to available evidence via evidence_claim_ids.",
        ],
      });

      const output = await callV3Agent<Record<string, any>>({
        sql, ctx, stageKey: "company_genesis", taskKey,
        taskType: "company_genesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
      });
      console.log("[company_genesis] DEBUG output keys:", Object.keys(output || {}).join(", "));

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = ["company_genesis", "founder_profile", "strategic_history_timeline", "strategic_dna"];
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
          AND (task_key = ${`genesis-researcher:${ctx.symbol?.toLowerCase() || "asset"}-genesis`} OR task_type = 'company_genesis')
          AND status = 'completed'
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No completed company genesis artifact found");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
