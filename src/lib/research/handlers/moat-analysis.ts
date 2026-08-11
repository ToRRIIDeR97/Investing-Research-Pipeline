import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { MOAT_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { loadAcceptedEvidencePacket } from "../system-pipeline";
import { CURRENT_PIPELINE_VERSION } from "../version";

export const moatAnalysisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "moat_analysis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const evidenceClaims = await loadAcceptedEvidencePacket(sql, {
        runId: ctx.runId, runType: ctx.runType, assetId: ctx.assetId, assetName: ctx.assetName,
        assetSlug: ctx.assetSlug, symbol: ctx.symbol, profileId: ctx.profileId || "", profileKey: ctx.profileKey || "",
        requiredModules: [], requiredLenses: [], marketDataCutoffAt: ctx.marketDataCutoffAt?.toISOString() || null,
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      });
      const upstreamRows = await sql`
        SELECT artifact_type, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('segment_model', 'customer_decision_map', 'business_process_map', 'bottleneck_register', 'competitive_response_matrix', 'historical_diagnosis')
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type
      `;
      const upstream = Object.fromEntries(upstreamRows.map((row) => [String(row.artifact_type), row.content_json]));
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["moat_durability", "competitive_advantage_sources"],
        output_contract: "moat_analysis",
        output_schema: MOAT_CONTRACT.schema,
        evidence_claims: evidenceClaims,
        upstream_artifacts: upstream,
      };
      const taskKey = `moat-analyst:assessment:v3:${createHash("sha256").update(JSON.stringify(packet)).digest("hex").slice(0, 12)}`;

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: MOAT_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Assess moat sources: network effects, high switching costs, cost advantages, intangible assets.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          "Ground every moat claim in evidence_claims and upstream_artifacts. Treat an unsupported claimed advantage as unproven, and translate each competitive response and bottleneck into an explicit durability or attack assessment.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "moat_analysis", taskKey,
        taskType: "moat_analysis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: MOAT_CONTRACT,
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = MOAT_CONTRACT.requiredKeys;
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
      const artifactKeys = MOAT_CONTRACT.requiredKeys;
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
