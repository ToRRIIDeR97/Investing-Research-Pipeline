import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { HISTORICAL_DIAGNOSIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const historicalDiagnosisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "historical_diagnosis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
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
        output_contract: "historical_diagnosis",
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: HISTORICAL_DIAGNOSIS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Perform a rigorous statistical level-shift and growth inflection analysis of the twenty-quarter historical record.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "historical_diagnosis", taskKey,
        taskType: "historical_diagnosis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: HISTORICAL_DIAGNOSIS_CONTRACT,
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = HISTORICAL_DIAGNOSIS_CONTRACT.requiredKeys;
      for (const k of subKeys) {
        if (output[k]) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "validated",
            content_json: output[k],
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, _output: unknown): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const errors: string[] = [];
      const artifactKeys = HISTORICAL_DIAGNOSIS_CONTRACT.requiredKeys;
      for (const k of artifactKeys) {
        const rows = await sql`
          SELECT COUNT(*) as cnt FROM research_artifacts
          WHERE research_run_id = ${ctx.runId}
            AND artifact_type = ${k}
            AND status IN ('validated', 'accepted')
        `;
        if (Number(rows[0].cnt) === 0) {
          errors.push(`Missing required artifact: ${k}`);
        }
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
