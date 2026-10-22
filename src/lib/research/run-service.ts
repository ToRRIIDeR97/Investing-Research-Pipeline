import postgres from "postgres";
import { getAllStagesForRun } from "@/lib/workflow/stages";
import { CURRENT_PIPELINE_VERSION } from "./version";

export interface CreateResearchRunInput {
  assetId: string;
  runType: string;
  researchQuestion: string | null;
  requestedBy: string | null;
  profileId: string | null;
  profileVersion: number | null;
  budgetLimitUsd: number | null;
  forecastYears?: number | null;
  sourceCutoffAt: Date | null;
  marketDataCutoffAt: Date | null;
}
/**
 * Create a run and its complete stage ledger in one database transaction.
 * A run without its 24 stage rows is not a valid UI-created run.
 */
export async function createResearchRunWithStages(input: CreateResearchRunInput) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    return await sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO research_runs (
          asset_id, run_type, status, research_question, requested_by,
          profile_id, profile_version, budget_limit_usd, forecast_years,
          source_cutoff_at, market_data_cutoff_at, pipeline_version,
          metadata_json, created_at, updated_at
        ) VALUES (
          ${input.assetId}, ${input.runType}, 'pending', ${input.researchQuestion},
          ${input.requestedBy}, ${input.profileId}, ${input.profileVersion},
          ${input.budgetLimitUsd === null ? null : String(input.budgetLimitUsd)}, ${input.forecastYears ?? null},
          ${input.sourceCutoffAt}, ${input.marketDataCutoffAt},
          ${CURRENT_PIPELINE_VERSION}, '{}'::jsonb, NOW(), NOW()
        )
        RETURNING *
      `;
      const run = inserted[0];
      if (!run) throw new Error("Unable to create research run");

      const { applicable, skipped } = getAllStagesForRun(input.runType);
      const stages = [...applicable, ...skipped].sort((a, b) => a.order - b.order);
      for (const stage of stages) {
        const skippedStage = skipped.some((candidate) => candidate.key === stage.key);
        await tx`
          INSERT INTO research_stages (
            research_run_id, stage_key, stage_order, status,
            allowed_model_tiers, max_retries, budget_limit_usd,
            completion_criteria_json, validator_config_json, failure_reason,
            created_at, updated_at
          ) VALUES (
            ${run.id}, ${stage.key}, ${stage.order}, ${skippedStage ? "skipped" : "pending"},
            ${stage.allowedModelTiers}, ${stage.maxRetries},
            ${stage.maxBudgetUsd === null ? null : String(stage.maxBudgetUsd)},
            ${tx.json({
              requiredOutputs: stage.requiredOutputs,
              requiresHumanApproval: stage.requiresHumanApproval,
              entryCriteria: stage.entryCriteria,
              validationRules: stage.validationRules,
              failureState: stage.failureState,
              ...(skippedStage ? { skipReason: stage.skipReason || `Skipped for run type: ${input.runType}` } : {}),
            })},
            '{}'::jsonb,
            ${skippedStage ? stage.skipReason || `Skipped for run type: ${input.runType}` : null},
            NOW(), NOW()
          )
        `;
      }
      return run;
    });
  } finally {
    await sql.end();
  }
}
