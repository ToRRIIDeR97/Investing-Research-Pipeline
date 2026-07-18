import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { COMPANY_GENESIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const companyGenesisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "company_genesis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
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
        output_contract: "company_genesis",
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: COMPANY_GENESIS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Provide a detailed synthesis of the company genesis, founders, and early corporate structure.",
          "Link analysis to available evidence via evidence_claim_ids.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "company_genesis", taskKey,
        taskType: "company_genesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: COMPANY_GENESIS_CONTRACT,
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = COMPANY_GENESIS_CONTRACT.requiredKeys;
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
      const artifactKeys = COMPANY_GENESIS_CONTRACT.requiredKeys;
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
