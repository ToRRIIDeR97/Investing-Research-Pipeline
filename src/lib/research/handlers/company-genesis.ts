import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { COMPANY_GENESIS_CONTRACT } from "../stage-contracts";
import { loadAcceptedEvidencePacket } from "../sources/corpus";
import {
  dropInvalidCitationIds,
  missingRequiredSourceRoles,
  validateArtifactCitationIds,
} from "../sources/artifact-evidence";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";

/** Rules for the genesis analyst. The founder rules match validateGenesisArtifact and validateFounderProfile. */
export const GENESIS_PROMPT_RULES = [
  "Every factual statement in current_implications must have matching cited historical_evidence. Omit unsupported statements; never add an issuer-specific exception.",
  "Provide a detailed synthesis of the company genesis, founders, and early corporate structure.",
  "Return each nested artifact as an object with the exact artifact_type and required_fields supplied in artifact_shape.",
  "Every narrative field named in required_fields is a non-empty string unless explicitly described below; do not return arrays for narrative strings.",
  "founder_motivations and motivations entries require motivation, evidence_claim_ids, and numeric confidence.",
  "motivation must be exactly one of: personal_problem, mission_or_cause, technical_conviction, commercial_opportunity, financial_ambition, competitive_ambition, professional_frustration, status_or_legacy, mixed, unknown.",
  "alternative_motivation_interpretations and alternative_interpretations are non-empty arrays of strings.",
  "present_day_implications, persistent_behaviors, decision_patterns, capital_allocation_habits, talent_and_organization_patterns, and current_implications are non-empty arrays of strings.",
  "material_claims and historical_evidence entries require claim, evidence_weight, evidence_claim_ids, and numeric confidence.",
  "evidence_weight must be exactly one of: contemporary_direct_founder_statement, later_retrospective_founder_statement, contemporary_third_party_observation, documented_company_action, analyst_inference, disputed_corporate_account.",
  "founder_profile is one object for the principal founder, never an array.",
  "Timeline events require date_or_period, event, objective_at_the_time, decision, evidence_claim_ids, immediate_effect, lasting_consequence, strategy_changed, mission_changed, and confidence.",
  "strategic_history_timeline.major_pivots is a non-empty array of strings, never objects.",
  "Use only UUID evidence claim IDs present in evidence_claims. Never invent citation IDs.",
  "company_genesis.founder_motivations and founder_profile.motivations each need at least one entry whose motivation is not unknown and that cites the accepted founder or origin evidence claim supporting it. unknown is allowed only for additional entries.",
  "Where the evidence says nothing more about the founders, state that limitation in founder_background and background_summary rather than inventing history.",
];

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
      const taskKey = "genesis-researcher:genesis";
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
        extraRules: GENESIS_PROMPT_RULES,
      });

      let output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "company_genesis", taskKey,
        taskType: "company_genesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: COMPANY_GENESIS_CONTRACT,
      });
      const allowedClaimRows = await sql`
        SELECT id FROM evidence_claims
        WHERE research_run_id = ${ctx.runId} AND review_status = 'accepted'
      `;
      const citationValidation = validateArtifactCitationIds(
        output,
        allowedClaimRows.map((row) => String(row.id))
      );
      if (!citationValidation.valid) {
        const repairPacket = {
          ...packet,
          draft_requiring_citation_repair: output,
          invalid_evidence_claim_ids: citationValidation.invalidIds,
          allowed_evidence_claim_ids: allowedClaimRows.map((row) => String(row.id)),
          repair_instruction:
            "Return the complete four-artifact output again. Replace an invalid citation only when an allowed evidence claim directly supports the statement. Otherwise remove the unsupported statement, keeping at least one supported founder motivation. Never invent a UUID.",
        };
        output = await callResearchAgent<Record<string, any>>({
          sql,
          ctx,
          stageKey: "company_genesis",
          taskKey: `${taskKey}:citation-repair`,
          taskType: "company_genesis_citation_repair",
          agentName: "asset-analyst",
          modelTier: "mid",
          packet: repairPacket,
          promptFactory,
          outputFormat: COMPANY_GENESIS_CONTRACT,
        });
        // IDs still unknown after the repair are dropped and recorded on company_genesis, not thrown;
        // an entry left with no supporting citation is removed rather than failing the artifact contract.
        const dropped = dropInvalidCitationIds(output, allowedClaimRows.map((row) => String(row.id)), { pruneUncited: true });
        if (dropped.length) {
          console.warn(`company genesis dropped citations outside the accepted packet: ${dropped.join(", ")}`);
          if (output.company_genesis && typeof output.company_genesis === "object") {
            output.company_genesis.citation_adjustments = { dropped_citation_ids: dropped };
          }
        }
      }

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
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
};
