import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgentArtifacts, exactJsonPrompt } from "../run-context";
import { BUSINESS_PROCESS_CONTRACT } from "../stage-contracts";
import {
  validateBottleneckRegister,
  validateBusinessProcessMap,
  validateCompetitiveResponseMatrix,
  validateCustomerDecisionMap,
  validateSegmentModel,
} from "../business/validation";
import { loadAcceptedEvidencePacket } from "../system-pipeline";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { CURRENT_PIPELINE_VERSION } from "../version";

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
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      });
      const evidenceFingerprint = createHash("sha256")
        .update(JSON.stringify(evidenceClaims))
        .digest("hex")
        .slice(0, 12);
      const taskKey = `business-model-analyst:process-map:v5:${evidenceFingerprint}`;
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["customer_funnel_mechanics", "segment_economics", "business_process_flow"],
        evidence_claims: evidenceClaims,
      };

      const promptFactory = (p: Record<string, unknown>, artifactKey: string) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: [artifactKey],
        packet: p,
        extraRules: [
          "Document segment unit-economics and trace buyer/seller/user acquisition and transaction flow diagrams.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          "Use accepted_artifacts as validated upstream context; do not reproduce them in the response.",
          "Keep the response bounded to the requested artifact: maximum four segments, one customer group per segment, two to four process_nodes, one bottleneck, or at least two distinct competitor categories with one response scenario each.",
          "Do not collapse a diversified company into one representative segment when evidence identifies multiple reported segments.",
          "business_process_map must contain process_nodes, never process_steps.",
          "For every segment whose segment_name contains lending, lender, or credit, include lender_details with non-empty funding_cost and credit_losses strings.",
          "For every segment whose segment_name contains marketplace or commerce, include marketplace_details with non-empty buyers, transactions, gmv, and take_rate strings.",
          "Each process node must cite only UUIDs copied exactly from evidence_claims in supporting_claim_ids.",
          "If competitor market share is not disclosed, use 0 rather than inventing a percentage.",
          "bottleneck_register.capacity_limit must be greater than 0. If no physical capacity is disclosed, use 1 with unit='qualitative constraint index' and explain the constraint in description.",
        ],
      });

      const validators: Record<string, (value: unknown) => Pick<ValidationResult, "valid" | "errors" | "warnings">> = {
        segment_model: validateSegmentModel,
        customer_decision_map: validateCustomerDecisionMap,
        business_process_map: validateBusinessProcessMap,
        bottleneck_register: validateBottleneckRegister,
        competitive_response_matrix: validateCompetitiveResponseMatrix,
      };
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const output = await callResearchAgentArtifacts({
        sql, ctx, stageKey: "business_process_analysis", taskKeyPrefix: taskKey,
        taskType: "business_process_analysis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: BUSINESS_PROCESS_CONTRACT,
        artifactWaves: [
          ["segment_model", "customer_decision_map"],
          ["business_process_map"],
          ["bottleneck_register", "competitive_response_matrix"],
        ],
        validateArtifact: (artifactKey, value) => validators[artifactKey](value),
        onArtifact: async (artifactKey, value) => {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: artifactKey,
            scope_key: `${ctx.assetSlug}-${artifactKey.replace(/_/g, "-")}`,
            status: "draft",
            content_json: value,
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
            idempotency_key: `${ctx.runId}-${artifactKey}`,
          });
        },
      });
      await sql`
        UPDATE research_artifacts
        SET status = 'validated', updated_at = NOW()
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = ANY(${BUSINESS_PROCESS_CONTRACT.requiredKeys})
      `;

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
