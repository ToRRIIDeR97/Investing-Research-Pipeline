import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { COMPANY_GENESIS_CONTRACT } from "../stage-contracts";
import { loadAcceptedEvidencePacket } from "../system-pipeline";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const companyGenesisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "company_genesis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = `genesis-researcher:${ctx.symbol?.toLowerCase() || "asset"}-genesis:v2`;
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
        evidence_claims: evidenceClaims,
        artifact_shape: {
          company_genesis: {
            artifact_type: "company_genesis",
            required_fields: [
              "pre_founding_environment", "customer_problem", "incumbent_failure",
              "enabling_change", "founder_background", "founder_motivations",
              "alternative_motivation_interpretations", "original_product",
              "original_customer", "original_geography", "original_revenue_model",
              "initial_funding", "early_constraints", "first_proof_point",
              "present_day_implications", "material_claims",
            ],
          },
          founder_profile: {
            artifact_type: "founder_profile",
            required_fields: [
              "founder_name", "background_summary", "motivations",
              "alternative_interpretations", "control_evolution", "influence_today",
            ],
          },
          strategic_history_timeline: {
            artifact_type: "strategic_history_timeline",
            required_fields: ["events", "major_pivots"],
          },
          strategic_dna: {
            artifact_type: "strategic_dna",
            required_fields: [
              "persistent_behaviors", "decision_patterns", "capital_allocation_habits",
              "talent_and_organization_patterns", "historical_evidence", "current_implications",
            ],
          },
        },
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: COMPANY_GENESIS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Provide a detailed synthesis of the company genesis, founders, and early corporate structure.",
          "Return each nested artifact as an object with the exact artifact_type and required_fields supplied in artifact_shape.",
          "founder_motivations and motivations entries require motivation, evidence_claim_ids, and numeric confidence.",
          "material_claims and historical_evidence entries require claim, evidence_weight, evidence_claim_ids, and numeric confidence.",
          "Timeline events require date_or_period, event, objective_at_the_time, decision, evidence_claim_ids, immediate_effect, lasting_consequence, strategy_changed, mission_changed, and confidence.",
          "Use only UUID evidence claim IDs present in evidence_claims. Never invent citation IDs.",
          "When founder evidence is unavailable, state the limitation and use motivation=unknown rather than inventing history.",
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
