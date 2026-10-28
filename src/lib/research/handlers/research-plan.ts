import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import postgres from "postgres";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { getAllStagesForRun } from "@/lib/workflow/stages";
import { STANDARD_VERSION, COVERAGE, RESEARCH_DOCTRINE } from "../reporting/contracts";
import { TEAM_ROLES, STAGE_DEPENDENCIES, STAGE_OWNERS } from "../team-plan";
import { forecastYears } from "../valuation/engine";
import { callResearchAgent, exactJsonPrompt, loadRunContext, persistV3Composition, stripNul, type Sql } from "../run-context";
import { FRAMING_RULES, framingContract, mergeFramingArchetypes, type ResearchFraming } from "../framing";
import { businessArchetypes, archetypeOverlays } from "../archetypes/registry";

export interface PlanFeedback { notes: string; requested_by: string; requested_at: string }

/** The plan artifact: code-built scope plus the model's framing (hypotheses until the reviewer approves them). */
export function buildResearchPlan(ctx: import("../run-context").ResearchRunContext,
  extras: { framing?: ResearchFraming | null; feedback?: PlanFeedback[]; framingSource?: "model" | "reviewer" } = {}) {
  const profile = ctx.composedProfile;
  const { applicable, skipped } = getAllStagesForRun(ctx.runType);
  const plannedStages = [
    ...applicable.map((stage) => ({ stage, ledger_status: "planned", skip_reason: null })),
    ...skipped.map((stage) => ({
      stage,
      ledger_status: "skipped",
      skip_reason: stage.skipReason || `Skipped for run type: ${ctx.runType}`,
    })),
  ].sort((a, b) => a.stage.order - b.stage.order);
  return {
    artifact_type: "research_plan",
    asset: {
      id: ctx.assetId,
      name: ctx.assetName,
      slug: ctx.assetSlug,
      profile_id: ctx.profileId,
      profile_key: ctx.profileKey,
    },
    research_question: ctx.researchQuestion,
    research_team: { roles: TEAM_ROLES, stage_owners: STAGE_OWNERS, dependencies: STAGE_DEPENDENCIES,
      max_report_request_rounds: 2, source_escalations_per_round: 1 },
    report_standard: {
      version: STANDARD_VERSION,
      output_requirements: `${RESEARCH_DOCTRINE.length} doctrine rules, applied in every analysis and report prompt (not repeated here).`,
      required_coverage: COVERAGE,
      historical_policy: "Latest reported fiscal periods available by source cutoff; target 20 quarters where applicable. Disclose unavailable periods and use the issuer's reporting frequency.",
      editorial_policy: "Choose section titles and order from material questions; add company-specific sections. Write executive judgment after the body. Preserve evidence, counterarguments, assumptions and uncertainty.",
      questions: extras.framing
        ? [extras.framing.central_question, ...extras.framing.key_questions.map(q => q.question)]
        : [ctx.researchQuestion || `What determines the value accruing to holders of ${ctx.assetName}?`],
      max_sections: 24, max_repair_rounds: 1,
      investigation_scope: "Accepted run corpus and analytical artifacts; unavailable evidence is recorded as a follow-up rather than invented.",
    },
    framing: extras.framing ?? null,
    framing_source: extras.framing ? extras.framingSource ?? "model" : null,
    plan_feedback: extras.feedback ?? [],
    run_type: ctx.runType,
    composed_archetypes: profile?.archetypes || ctx.archetypeKeys,
    overlays: profile?.overlays || ctx.overlayKeys,
    required_source_roles: profile?.source_roles || [],
    required_historical_metrics: profile?.historical_metrics || [],
    required_analysis_modules: profile?.required_artifacts || [],
    required_process_nodes: profile?.required_process_nodes || [],
    valuation_methods: profile?.valuation_methods || [],
    backtest_requirement: {
      required: true,
      rationale: "The current v3 workflow includes the five-bucket framework backtest before decision synthesis.",
    },
    applicable_stages: plannedStages.map(({ stage, ledger_status, skip_reason }) => ({
      key: stage.key,
      order: stage.order,
      name: stage.name,
      description: stage.description,
      requires_human_approval: stage.requiresHumanApproval,
      ledger_status,
      skip_reason,
    })),
    // The explicit forecast horizon; the reviewer may change it when approving the plan (research_runs.forecast_years).
    forecast_years: forecastYears(ctx.forecastYears),
    cutoffs: {
      source_cutoff_at: ctx.cutoffAt.toISOString(),
      market_data_cutoff_at: ctx.marketDataCutoffAt?.toISOString() || null,
    },
    budget: {
      limit_usd: ctx.budgetLimitUsd || null,
      spent_usd: ctx.budgetSpentUsd,
      remaining_usd: ctx.budgetLimitUsd ? ctx.budgetRemainingUsd : null,
    },
    generated_at: new Date().toISOString(),
  };
}

/** One framing call; a redraft carries every feedback note and the previous framing. */
async function draftFraming(sql: Sql, ctx: ResearchRunContext, feedback: PlanFeedback[]): Promise<ResearchFraming> {
  const [asset] = await sql`SELECT sector, industry, home_country, asset_kind FROM assets WHERE id = ${ctx.assetId}`;
  const [previous] = feedback.length ? await sql`SELECT content_json->'framing' AS framing FROM research_artifacts
    WHERE research_run_id = ${ctx.runId} AND artifact_type = 'research_plan' ORDER BY artifact_version DESC LIMIT 1` : [];
  const contract = framingContract();
  const packet = {
    asset: { name: ctx.assetName, symbol: ctx.symbol, sector: asset?.sector ?? null, industry: asset?.industry ?? null,
      home_country: asset?.home_country ?? null, asset_kind: asset?.asset_kind ?? null },
    research_question: ctx.researchQuestion, run_type: ctx.runType, source_cutoff: ctx.cutoffAt.toISOString(),
    current_archetypes: { archetypes: ctx.archetypeKeys, overlays: ctx.overlayKeys },
    archetype_choices: businessArchetypes.map(({ key, name, description }) => ({ key, name, description })),
    overlay_choices: archetypeOverlays.map(({ key, name }) => ({ key, name })),
    human_plan_feedback: feedback.map(f => f.notes), previous_framing: previous?.framing ?? null,
    output_contract: "research_framing",
  };
  const result = await callResearchAgent<{ framing: ResearchFraming }>({ sql, ctx, stageKey: "research_plan",
    taskKey: `plan:framing:${feedback.length}`, taskType: "research_framing", agentName: "asset-analyst", modelTier: "mid", packet,
    outputFormat: contract, promptFactory: p => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: contract.requiredKeys, packet: p,
      extraRules: FRAMING_RULES }) });
  return result.framing;
}

export const researchPlanHandler: StageHandler<unknown> = {
  stageKey: "research_plan",
  async execute(ctx: ResearchRunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}`;
      const metadata = (run?.metadata_json || {}) as Record<string, any>;
      const feedback: PlanFeedback[] = Array.isArray(metadata.research_plan_feedback) ? metadata.research_plan_feedback : [];
      const framing = stripNul(await draftFraming(sql as unknown as Sql, ctx, feedback));
      // The framing may add archetypes unless the run was created with them or the reviewer chose them.
      let planCtx = ctx;
      const merged = ["request", "reviewer"].includes(String(metadata.v3_archetypes_source))
        ? null : mergeFramingArchetypes({ archetypes: ctx.archetypeKeys, overlays: ctx.overlayKeys }, framing, ctx.assetId);
      if (merged) {
        await persistV3Composition(sql as unknown as Sql, ctx.runId, merged.archetypes, merged.overlays);
        await sql`UPDATE research_runs SET metadata_json = coalesce(metadata_json, '{}'::jsonb) || ${sql.json({ v3_archetypes_source: "framing" })} WHERE id = ${ctx.runId}`;
        planCtx = { ...(await loadRunContext(sql as unknown as Sql, ctx.runId)), signal: ctx.signal };
      }
      const plan = buildResearchPlan(planCtx, { framing, feedback });
      const artifact = await repo.upsertArtifact({
        research_run_id: ctx.runId,
        asset_id: ctx.assetId,
        profile_id: ctx.profileId || undefined,
        artifact_type: "research_plan",
        scope_key: `${ctx.assetSlug}-research-plan`,
        status: "validated",
        content_json: plan,
        schema_version: "3.0.0",
        validator_version: "1.0.0",
        prompt_version: "framing-v1",
        validation_result_json: { valid: true, generated: true },
        created_by: "system-research-os",
      });

      const completionCriteria = stripNul({
        requiredOutputs: ["research_plan_json"],
        plan_artifact_id: artifact.id,
        research_plan: plan,
      });
      await sql`
        UPDATE research_stages
        SET completion_criteria_json = ${sql.json(completionCriteria as any)}, updated_at = NOW()
        WHERE research_run_id = ${ctx.runId} AND stage_key = 'research_plan'
      `;
      return { status: "success", artifactId: artifact.id, researchPlan: plan };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT completion_criteria_json
        FROM research_stages
        WHERE research_run_id = ${ctx.runId} AND stage_key = 'research_plan'
      `;
      const errors: string[] = [];
      if (rows.length === 0 || !rows[0].completion_criteria_json) {
        errors.push("Research plan JSON not found in stage completion criteria");
      }
      const artifacts = await sql`
        SELECT id FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'research_plan'
          AND status IN ('validated', 'accepted')
        LIMIT 1
      `;
      if (!artifacts[0]) errors.push("Persisted research_plan artifact not found");
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
