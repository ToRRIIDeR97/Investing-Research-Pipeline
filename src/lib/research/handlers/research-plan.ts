import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import postgres from "postgres";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { getAllStagesForRun, shouldSkipOptionalBacktest } from "@/lib/workflow/stages";

function buildResearchPlan(ctx: import("../run-context").ResearchRunContext) {
  const profile = ctx.composedProfile;
  const { applicable, skipped } = getAllStagesForRun(ctx.runType);
  const plannedStages = [
    ...applicable.map((stage) => shouldSkipOptionalBacktest(stage.key, profile?.backtest_required === true)
      ? { stage, ledger_status: "skipped", skip_reason: "No accepted timing hypothesis." }
      : { stage, ledger_status: "planned", skip_reason: null }),
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
    run_type: ctx.runType,
    composed_archetypes: profile?.archetypes || ctx.archetypeKeys,
    overlays: profile?.overlays || ctx.overlayKeys,
    required_source_roles: profile?.source_roles || [],
    required_historical_metrics: profile?.historical_metrics || [],
    required_analysis_modules: profile?.required_artifacts || [],
    required_process_nodes: profile?.required_process_nodes || [],
    valuation_methods: profile?.valuation_methods || [],
    backtest_requirement: {
      required: profile?.backtest_required ?? false,
      rationale: profile?.backtest_required
        ? "An explicit timing hypothesis was accepted for testing."
        : "No accepted timing hypothesis; backtesting is optional for fundamental synthesis.",
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

      await sql`
        UPDATE research_stages
        SET completion_criteria_json = ${sql.json({
          requiredOutputs: ["research_plan_json"],
          plan_artifact_id: artifact.id,
          research_plan: plan,
        })}, updated_at = NOW()
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
