import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent } from "../run-context";
import { COMPANY_GENESIS_CONTRACT, GENESIS_HISTORY_CONTRACT, GENESIS_ORIGIN_CONTRACT } from "../stage-contracts";
import { partCall, runSplitStage } from "./split-calls";
import { loadAcceptedEvidencePacket } from "../sources/corpus";
import {
  dropInvalidCitationIds,
  missingRequiredSourceRoles,
  validateArtifactCitationIds,
} from "../sources/artifact-evidence";
import { createArtifactRepository } from "../artifacts/repository";
import { pipelineDb, pipelineSql } from "@/db/pipeline-sql";
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

/**
 * Added when the run has no founder or company-history document. Source discovery already records the gap
 * (missing_founder_and_company_history, owned by system:source-collector); the stage writes the history from what the
 * run holds instead of stopping (SoFi run 7c70364e stopped here when web search found no history page).
 */
export const MISSING_HISTORY_RULE = "missing_source_roles names the source roles this run could not fetch. With no founder or company-history document, build the history from the filings and other accepted evidence_claims (the business and history sections of annual reports and registration statements, results releases, proxy statements): cite those claims, use documented_company_action or analyst_inference as evidence_weight with low confidence, and state in founder_background and background_summary that no founder or company-history source was available. Do not invent founders, dates or motivations the evidence does not support.";

/** The source roles the genesis stage reads; a missing one becomes a packet note, not a stop. */
export function genesisMissingRoles(presentRoles: string[]) {
  return missingRequiredSourceRoles(["founder_and_company_history"], presentRoles);
}

export const companyGenesisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "company_genesis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = pipelineSql();
    const roleRows = await sql`
      SELECT DISTINCT sra.role
      FROM source_role_assignments sra
      JOIN source_documents sd ON sd.id = sra.source_document_id
      LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
      WHERE (sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId})
        AND sra.confidence >= 70
    `;
    const missingRoles = genesisMissingRoles(roleRows.map((row) => String(row.role)));
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
      ...(missingRoles.length ? { missing_source_roles: missingRoles } : {}),
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

    // Two calls side by side: the origin and founder, and the strategic history (split-calls.ts). Each is given
    // artifact_shape for its own artifacts only.
    const { artifact_shape: shape, ...shared } = packet;
    const shapeFor = (contract: { requiredKeys: string[] }) =>
      ({ artifact_shape: Object.fromEntries(contract.requiredKeys.map((key) => [key, (shape as Record<string, unknown>)[key]])) });
    const split = {
      sql, ctx, stageKey: "company_genesis", taskKey, taskType: "company_genesis", agentName: "asset-analyst" as const, modelTier: "mid",
      packet: shared, rules: missingRoles.length ? [...GENESIS_PROMPT_RULES, MISSING_HISTORY_RULE] : GENESIS_PROMPT_RULES,
      parts: [
        { name: "origin", contract: GENESIS_ORIGIN_CONTRACT, rules: [], extra: shapeFor(GENESIS_ORIGIN_CONTRACT) },
        { name: "history", contract: GENESIS_HISTORY_CONTRACT, rules: [], extra: shapeFor(GENESIS_HISTORY_CONTRACT) },
      ],
    };
    const output = await runSplitStage(split);
    const allowedClaimRows = await sql`
      SELECT id FROM evidence_claims
      WHERE research_run_id = ${ctx.runId} AND review_status = 'accepted'
    `;
    const allowedIds = allowedClaimRows.map((row) => String(row.id));
    // A part citing an unknown claim id is rerun once with the allowed ids; the other part is kept as it is.
    let repaired = false;
    for (const part of split.parts) {
      const own = Object.fromEntries(part.contract.requiredKeys.map((key) => [key, output[key]]));
      const citationValidation = validateArtifactCitationIds(own, allowedIds);
      if (citationValidation.valid) continue;
      repaired = true;
      const answer = await callResearchAgent<Record<string, any>>(partCall(split, part, output, {
        taskKey: `${taskKey}:${part.name}:citation-repair`, taskType: "company_genesis_citation_repair",
        extra: {
          draft_requiring_citation_repair: own,
          invalid_evidence_claim_ids: citationValidation.invalidIds,
          allowed_evidence_claim_ids: allowedIds,
          repair_instruction:
            "Return this call's artifacts again in full. Replace an invalid citation only when an allowed evidence claim directly supports the statement. Otherwise remove the unsupported statement, keeping at least one supported founder motivation. Never invent a UUID.",
        },
      }));
      for (const key of part.contract.requiredKeys) output[key] = answer[key];
    }
    if (repaired) {
      // IDs still unknown after the repair are dropped and recorded on company_genesis, not thrown;
      // an entry left with no supporting citation is removed rather than failing the artifact contract.
      const dropped = dropInvalidCitationIds(output, allowedIds, { pruneUncited: true });
      if (dropped.length) {
        console.warn(`company genesis dropped citations outside the accepted packet: ${dropped.join(", ")}`);
        if (output.company_genesis && typeof output.company_genesis === "object") {
          output.company_genesis.citation_adjustments = { dropped_citation_ids: dropped };
        }
      }
    }

    // Persist generated sub-artifacts
    const db = pipelineDb();
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
  },
};
