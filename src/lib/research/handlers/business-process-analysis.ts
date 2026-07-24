import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { BUSINESS_PROCESS_CONTRACT } from "../stage-contracts";
import { loadAcceptedEvidencePacket } from "../system-pipeline";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";

export const businessProcessAnalysisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "business_process_analysis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const evidenceClaims = await loadAcceptedEvidencePacket(sql, {
        runId: ctx.runId,
        runType: ctx.runType,
        assetId: ctx.assetId,
        assetName: ctx.assetName,
        assetSlug: ctx.assetSlug,
        symbol: ctx.symbol,
        profileId: ctx.profileId || "",
        profileKey: ctx.profileKey || "",
        requiredModules: [],
        requiredLenses: [],
        marketDataCutoffAt: ctx.marketDataCutoffAt?.toISOString() || null,
        pipelineVersion: 3,
      });
      const evidenceFingerprint = createHash("sha256")
        .update(JSON.stringify(evidenceClaims))
        .digest("hex")
        .slice(0, 12);
      const taskKey = `business-model-analyst:process-map:v4:${evidenceFingerprint}`;
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["customer_funnel_mechanics", "segment_economics", "business_process_flow"],
        output_contract: "business_process_analysis",
        output_schema: BUSINESS_PROCESS_CONTRACT.schema,
        evidence_claims: evidenceClaims,
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: BUSINESS_PROCESS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Document segment unit-economics and trace buyer/seller/user acquisition and transaction flow diagrams.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          "The canonical bottleneck key and artifact_type are both bottleneck_register.",
          "Keep the response bounded: one representative segment, one customer group, two process_nodes, one bottleneck, and one competitor with one response scenario.",
          "business_process_map must contain process_nodes, never process_steps.",
          "Each process node must cite only UUIDs copied exactly from evidence_claims in supporting_claim_ids.",
          "If competitor market share is not disclosed, use 0 rather than inventing a percentage.",
          "bottleneck_register.capacity_limit must be greater than 0. If no physical capacity is disclosed, use 1 with unit='qualitative constraint index' and explain the constraint in description.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "business_process_analysis", taskKey,
        taskType: "business_process_analysis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: BUSINESS_PROCESS_CONTRACT,
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = BUSINESS_PROCESS_CONTRACT.requiredKeys;
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
      const artifactKeys = BUSINESS_PROCESS_CONTRACT.requiredKeys;
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
