import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import postgres from "postgres";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { getAllStagesForRun } from "@/lib/workflow/stages";
import { STANDARD_VERSION, COVERAGE, RESEARCH_DOCTRINE } from "../reporting/contracts";
import { TEAM_ROLES, STAGE_DEPENDENCIES, STAGE_OWNERS } from "../team-plan";

function buildResearchPlan(ctx: import("../run-context").ResearchRunContext) {
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
      output_requirements: RESEARCH_DOCTRINE,
      required_coverage: COVERAGE,
      historical_policy: "Latest reported fiscal periods available by source cutoff; target 20 quarters where applicable. Disclose unavailable periods and use the issuer's reporting frequency.",
      editorial_policy: "Choose section titles and order from material questions; add company-specific sections. Write executive judgment after the body. Preserve evidence, counterarguments, assumptions and uncertainty.",
      questions: [ctx.researchQuestion || `What determines the value accruing to holders of ${ctx.assetName}?`,
        `Which operating constraints and capital-allocation choices could change ${ctx.assetName}'s per-share economics?`],
      max_sections: 24, max_repair_rounds: 1,
      investigation_scope: "Accepted run corpus and analytical artifacts; unavailable evidence is recorded as a follow-up rather than invented.",
    },
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

export const researchPlanHandler: StageHandler<unknown> = {
  stageKey: "research_plan",
  async execute(ctx: ResearchRunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const plan = buildResearchPlan(ctx);
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
        prompt_version: "deterministic-v1",
        validation_result_json: { valid: true, generated: true },
        created_by: "system-research-os",
        idempotency_key: `${ctx.runId}-research-plan`,
      });

      const completionCriteria = JSON.stringify({
        requiredOutputs: ["research_plan_json"],
        plan_artifact_id: artifact.id,
        research_plan: plan,
      }).replace(/'/g, "''");
      await sql`
        UPDATE research_stages
        SET completion_criteria_json = ${sql.unsafe(`'${completionCriteria}'::jsonb`)}, updated_at = NOW()
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
