import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgentArtifacts, exactJsonPrompt } from "../run-context";
import { COMPANY_GENESIS_CONTRACT } from "../stage-contracts";
import { loadAcceptedEvidencePacket } from "../system-pipeline";
import {
  missingRequiredSourceRoles,
  validateArtifactCitationIds,
} from "../sources/artifact-evidence";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { CURRENT_PIPELINE_VERSION } from "../version";

export const companyGenesisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "company_genesis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const roleRows = await sql`
        SELECT DISTINCT sra.role
        FROM source_role_assignments sra
        JOIN source_documents sd ON sd.id = sra.source_document_id
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE (sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId})
          AND sra.confidence >= 70
      `;
      const missingRoles = missingRequiredSourceRoles(
        ["founder_and_company_history"],
        roleRows.map((row) => String(row.role))
      );
      if (missingRoles.length > 0) {
        throw new Error(
          `Company genesis blocked by evidence coverage: missing ${missingRoles.join(", ")}`
        );
      }
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
      const taskKey = `genesis-researcher:${ctx.symbol?.toLowerCase() || "asset"}-genesis:v6:${evidenceFingerprint}`;
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
        output_schema: COMPANY_GENESIS_CONTRACT.schema,
        evidence_claims: evidenceClaims,
      };

      const artifactRules: Record<string, string[]> = {
        founder_profile: [
          "Profile the principal founder as one object. Cover motivations, alternative interpretations, control evolution and influence today.",
          "Motivations need accepted evidence IDs and numeric confidence. Use motivation=unknown where founder evidence is unavailable.",
        ],
        company_genesis: [
          "Explain the founding problem, enabling conditions, early product and funding, constraints, first proof point and present implications. Use the saved founder profile.",
          "Separate documented founder motivations from alternative interpretations. Mark analyst inference explicitly in material_claims.",
        ],
        strategic_history_timeline: [
          "Trace dated strategic decisions, their objectives and consequences. Distinguish a change in strategy from a change in mission.",
          "major_pivots is an array of strings. Each event needs accepted evidence IDs and numeric confidence.",
        ],
        strategic_dna: [
          "Infer persistent operating, capital-allocation and organizational habits from the saved founding history and timeline. Explain current implications.",
          "historical_evidence must distinguish documented actions from analyst inference and include accepted evidence IDs and numeric confidence.",
        ],
      };

      const promptFactory = (p: Record<string, unknown>, artifactKey: string) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: [artifactKey],
        packet: p,
        extraRules: [
          "Return only the requested artifact using output_schema. Use accepted_artifacts as prior checked context.",
          "Follow every nested field type and enum in output_schema. Narrative string fields must be non-empty strings, not arrays.",
          ...artifactRules[artifactKey],
          "Use only UUID evidence claim IDs present in evidence_claims. Never invent citation IDs.",
          "State missing evidence as a limitation rather than inventing history.",
        ],
      });

      const allowedClaimRows = await sql`
        SELECT id FROM evidence_claims
        WHERE research_run_id = ${ctx.runId}
          AND review_status IN ('machine_verified', 'accepted')
      `;
      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const output = await callResearchAgentArtifacts({
        sql, ctx, stageKey: 'company_genesis', taskKeyPrefix: taskKey,
        taskType: 'company_genesis', agentName: 'asset-analyst', packet, promptFactory,
        outputFormat: COMPANY_GENESIS_CONTRACT,
        artifactWaves: [['founder_profile', 'strategic_history_timeline'], ['company_genesis'], ['strategic_dna']],
        validateArtifact: (_key, value) => {
          const validation = validateArtifactCitationIds(value, allowedClaimRows.map((row) => String(row.id)));
          return makeValidationResult(validation.valid ? [] : [`Unaccepted citation IDs: ${validation.invalidIds.join(', ')}`]);
        },
        onArtifact: async (k, value) => {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "validated",
            content_json: value,
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        },
      });

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
