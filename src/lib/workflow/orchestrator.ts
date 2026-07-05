import postgres from "postgres";
import { STAGE_CONFIGS, STAGE_CONFIG_MAP, getAllStagesForRun, getApplicableStages } from "./stages";
import { validateStageCompletion, validateSourceLinks, validateAssetProfile, validatePointInTime, validateCompletionCriteria, ValidationResult } from "./validators";

// ============================================================
// Orchestrator — drives research runs through the stage FSM.
// This is deterministic application logic, not an AI agent.
// §26.1: read state → select stage → create tasks → validate → advance/fail
// ============================================================

export interface RunProgress {
  runId: string;
  status: string;
  currentStage: string | null;
  currentStageOrder: number | null;
  completedStages: string[];
  pendingStages: string[];
  failedStages: string[];
  skippedStages: string[];
  totalStages: number;
  percentComplete: number;
  totalCostUsd: number;
  validationResults: Record<string, ValidationResult>;
}

/**
 * Create research_stages records for all stages including explicitly skipped ones.
 * §25.2: Skipped stages must be explicitly marked skipped with a reason.
 */
export async function createStagesForRun(runId: string): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const runs = await sql`
      SELECT id, run_type FROM research_runs WHERE id = ${runId}
    `;
    if (runs.length === 0) {
      throw new Error(`Research run not found: ${runId}`);
    }

    const runType = runs[0].run_type;
    const { applicable, skipped } = getAllStagesForRun(runType);

    // Insert applicable stages as pending
    for (const stage of applicable) {
      await sql`
        INSERT INTO research_stages (
          research_run_id, stage_key, stage_order, status,
          allowed_model_tiers, max_retries, budget_limit_usd,
          completion_criteria_json, validator_config_json
        ) VALUES (
          ${runId},
          ${stage.key},
          ${stage.order},
          'pending',
          ${stage.allowedModelTiers},
          ${stage.maxRetries},
          ${stage.maxBudgetUsd?.toString() || null},
          ${JSON.stringify({
            requiredOutputs: stage.requiredOutputs,
            requiresHumanApproval: stage.requiresHumanApproval,
            entryCriteria: stage.entryCriteria,
            validationRules: stage.validationRules,
            failureState: stage.failureState,
          })}::jsonb,
          ${JSON.stringify({})}::jsonb
        )
        ON CONFLICT (research_run_id, stage_key) DO NOTHING
      `;
    }

    // Insert skipped stages with explicit reason — §25.2
    for (const stage of skipped) {
      await sql`
        INSERT INTO research_stages (
          research_run_id, stage_key, stage_order, status,
          allowed_model_tiers, max_retries,
          completion_criteria_json, validator_config_json,
          failure_reason
        ) VALUES (
          ${runId},
          ${stage.key},
          ${stage.order},
          'skipped',
          ${stage.allowedModelTiers},
          ${stage.maxRetries},
          ${JSON.stringify({
            requiredOutputs: stage.requiredOutputs,
            skipReason: stage.skipReason || `Skipped for run type: ${runType}`,
          })}::jsonb,
          ${JSON.stringify({})}::jsonb,
          ${stage.skipReason || `Skipped for run type: ${runType}`}
        )
        ON CONFLICT (research_run_id, stage_key) DO NOTHING
      `;
    }
  } finally {
    await sql.end();
  }
}

/**
 * Set a run to 'running' status and start the first applicable stage.
 */
export async function startRun(runId: string): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const runs = await sql`
      SELECT id, status FROM research_runs WHERE id = ${runId}
    `;
    if (runs.length === 0) {
      throw new Error(`Research run not found: ${runId}`);
    }

    if (runs[0].status !== "pending") {
      throw new Error(
        `Run cannot be started — current status is "${runs[0].status}"`
      );
    }

    await sql`
      UPDATE research_runs
      SET status = 'running',
          started_at = NOW(),
          updated_at = NOW()
      WHERE id = ${runId}
    `;

    // Start the first pending stage
    const firstStage = await sql`
      SELECT id, stage_key FROM research_stages
      WHERE research_run_id = ${runId}
        AND status = 'pending'
      ORDER BY stage_order ASC
      LIMIT 1
    `;

    if (firstStage.length > 0) {
      await sql`
        UPDATE research_stages
        SET status = 'running',
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = ${firstStage[0].id}
      `;
    }
  } finally {
    await sql.end();
  }
}

/**
 * Validate the current stage's completion, handle retries if validation fails,
 * check budget, mark it complete, and start the next pending stage.
 * §26.1: orchestrator should decide to continue, retry, escalate, pause, or fail.
 */
export async function advanceStage(
  runId: string
): Promise<{ success: boolean; nextStage?: string; action?: string; error?: string }> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Find the current running stage
    const runningStages = await sql`
      SELECT id, stage_key, stage_order, max_retries, budget_limit_usd, validation_result_json
      FROM research_stages
      WHERE research_run_id = ${runId}
        AND status = 'running'
      ORDER BY stage_order ASC
      LIMIT 1
    `;

    if (runningStages.length === 0) {
      return { success: false, error: "No stage is currently running" };
    }

    const currentStage = runningStages[0];
    const config = STAGE_CONFIG_MAP[currentStage.stage_key];

    // Check budget — §26.1 cost tracking
    if (currentStage.budget_limit_usd) {
      const stageCost = await sql`
        SELECT COALESCE(SUM(cost_usd::numeric), 0) as total
        FROM research_tasks
        WHERE stage_id = ${currentStage.id}
      `;
      const spent = Number(stageCost[0].total);
      const limit = Number(currentStage.budget_limit_usd);
      if (spent > limit) {
        // Budget exceeded — fail based on failure_state
        const failureState = config?.failureState || "skip_and_continue";
        if (failureState === "fail_run") {
          await failRun(runId, `Stage "${currentStage.stage_key}" exceeded budget: $${spent.toFixed(2)} > $${limit.toFixed(2)}`);
          return { success: false, action: "fail_run", error: "Budget exceeded" };
        } else {
          // Skip and continue
          await sql`
            UPDATE research_stages
            SET status = 'failed',
                failure_reason = ${`Budget exceeded: $${spent.toFixed(2)} > $${limit.toFixed(2)}`},
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = ${currentStage.id}
          `;
          const next = await startNextStage(runId);
          return { success: true, nextStage: next, action: "skip_and_continue" };
        }
      }
    }

    // Validate stage completion
    let validation = await validateStageCompletion(runId, currentStage.stage_key);

    // Run stage-specific validation rules — §28
    // Each stage declares which validators to run in validationRules[]
    if (validation.valid && config?.validationRules && config.validationRules.length > 0) {
      for (const rule of config.validationRules) {
        let ruleResult: ValidationResult;
        switch (rule) {
          case "source_link_validation":
            ruleResult = await validateSourceLinks(runId);
            break;
          case "asset_profile_validation":
            ruleResult = await validateAssetProfile(runId);
            break;
          case "point_in_time_validation":
            ruleResult = await validatePointInTime(runId);
            break;
          default:
            continue; // Unknown rule — skip
        }

        if (!ruleResult.valid) {
          validation = {
            valid: false,
            errors: [...validation.errors, ...ruleResult.errors],
            warnings: [...validation.warnings, ...ruleResult.warnings],
            checkedAt: new Date().toISOString(),
          };
          break; // First failing rule stops the stage
        }
        // Merge warnings even if passing
        validation.warnings.push(...ruleResult.warnings);
      }
    }

    if (!validation.valid) {
      // Handle retry — §26.1 retry logic
      const retryCount =
        Number(currentStage.validation_result_json?.retryCount ?? 0);
      const maxRetries = currentStage.max_retries || 2;

      if (retryCount < maxRetries) {
        const retryValidation = {
          ...validation,
          retryCount: retryCount + 1,
        };

        // Persist retry count in the validation payload; stage schema has no retry_count column.
        await sql`
          UPDATE research_stages
          SET validation_result_json = ${JSON.stringify(retryValidation)}::jsonb,
              updated_at = NOW()
          WHERE id = ${currentStage.id}
        `;
        return {
          success: false,
          action: "retry",
          error: `Stage "${currentStage.stage_key}" validation failed (retry ${retryCount + 1}/${maxRetries}): ${validation.errors.join("; ")}`,
        };
      }

      // Retries exhausted — handle based on failure_state
      const failureState = config?.failureState || "skip_and_continue";

      if (failureState === "fail_run") {
        await failRun(runId, `Stage "${currentStage.stage_key}" failed after ${maxRetries} retries: ${validation.errors.join("; ")}`);
        return { success: false, action: "fail_run", error: "Retries exhausted" };
      } else if (failureState === "pause_for_human") {
        await pauseForHumanReview(runId, `Stage "${currentStage.stage_key}" needs human input: ${validation.errors.join("; ")}`);
        return { success: true, action: "pause_for_human" };
      } else {
        // skip_and_continue
        await sql`
          UPDATE research_stages
          SET status = 'failed',
              failure_reason = ${`Failed after ${maxRetries} retries: ${validation.errors.join("; ")}`},
              validation_result_json = ${JSON.stringify(validation)}::jsonb,
              completed_at = NOW(),
              updated_at = NOW()
          WHERE id = ${currentStage.id}
        `;
        const next = await startNextStage(runId);
        return { success: true, nextStage: next, action: "skip_and_continue" };
      }
    }

    // Validation passed — mark stage completed
    await sql`
      UPDATE research_stages
      SET status = 'completed',
          completed_at = NOW(),
          validation_result_json = ${JSON.stringify(validation)}::jsonb,
          updated_at = NOW()
      WHERE id = ${currentStage.id}
    `;

    // Start next stage
    const next = await startNextStage(runId);
    return { success: true, nextStage: next, action: "continue" };
  } finally {
    await sql.end();
  }
}

/**
 * Helper: start the next pending stage. Returns the stage key or undefined.
 */
async function startNextStage(
  runId: string
): Promise<string | undefined> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const nextStages = await sql`
      SELECT id, stage_key
      FROM research_stages
      WHERE research_run_id = ${runId}
        AND status = 'pending'
      ORDER BY stage_order ASC
      LIMIT 1
    `;

    if (nextStages.length === 0) {
      // No more pending stages — check if any stages failed
      // §25.3: If required validators failed, status should be needs_more_work
      const failedStages = await sql`
        SELECT stage_key, failure_reason
        FROM research_stages
        WHERE research_run_id = ${runId}
          AND status = 'failed'
      `;

      if (failedStages.length > 0) {
        // Some stages failed — mark run as needs_more_work
        const failedKeys = failedStages.map((s) => s.stage_key);
        await sql`
          UPDATE research_runs
          SET status = 'needs_more_work',
              completed_at = NOW(),
              updated_at = NOW(),
              metadata_json = metadata_json || ${JSON.stringify({
                failed_stages: failedKeys,
                failure_summary: failedStages.map((s) => `${s.stage_key}: ${s.failure_reason}`),
              })}::jsonb
          WHERE id = ${runId}
        `;
      }
      return undefined; // No more stages
    }

    const nextStage = nextStages[0];
    const config = STAGE_CONFIG_MAP[nextStage.stage_key];

    if (config?.requiresHumanApproval) {
      await sql`
        UPDATE research_stages
        SET status = 'waiting_for_human',
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = ${nextStage.id}
      `;
      await sql`
        UPDATE research_runs
        SET status = 'waiting_for_human',
            updated_at = NOW()
        WHERE id = ${runId}
      `;
    } else {
      await sql`
        UPDATE research_stages
        SET status = 'running',
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = ${nextStage.id}
      `;
    }

    return nextStage.stage_key;
  } finally {
    await sql.end();
  }
}

/**
 * Get comprehensive progress for a research run.
 */
export async function getRunProgress(runId: string): Promise<RunProgress> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const runs = await sql`
      SELECT status, actual_cost_usd FROM research_runs WHERE id = ${runId}
    `;
    if (runs.length === 0) {
      throw new Error(`Research run not found: ${runId}`);
    }

    const stages = await sql`
      SELECT
        id, stage_key, stage_order, status,
        validation_result_json
      FROM research_stages
      WHERE research_run_id = ${runId}
      ORDER BY stage_order ASC
    `;

    const completedStages: string[] = [];
    const pendingStages: string[] = [];
    const failedStages: string[] = [];
    const skippedStages: string[] = [];
    const validationResults: Record<string, ValidationResult> = {};
    let currentStage: string | null = null;
    let currentStageOrder: number | null = null;

    for (const stage of stages) {
      const status = stage.status;

      if (status === "completed") {
        completedStages.push(stage.stage_key);
      } else if (status === "skipped") {
        skippedStages.push(stage.stage_key);
        completedStages.push(stage.stage_key); // count as done for progress
      } else if (status === "failed") {
        failedStages.push(stage.stage_key);
      } else if (status === "pending") {
        pendingStages.push(stage.stage_key);
      } else if (status === "running" || status === "waiting_for_human") {
        currentStage = stage.stage_key;
        currentStageOrder = stage.stage_order;
      }

      if (stage.validation_result_json) {
        validationResults[stage.stage_key] =
          stage.validation_result_json as unknown as ValidationResult;
      }
    }

    const totalStages = stages.length;
    const doneCount = completedStages.length;
    const percentComplete =
      totalStages > 0 ? Math.round((doneCount / totalStages) * 100) : 0;

    return {
      runId,
      status: runs[0].status,
      currentStage,
      currentStageOrder,
      completedStages,
      pendingStages,
      failedStages,
      skippedStages,
      totalStages,
      percentComplete,
      totalCostUsd: Number(runs[0].actual_cost_usd || 0),
      validationResults,
    };
  } finally {
    await sql.end();
  }
}

/**
 * Pause a run for human review.
 */
export async function pauseForHumanReview(
  runId: string,
  reason: string
): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    await sql`
      UPDATE research_runs
      SET status = 'waiting_for_human',
          metadata_json = metadata_json || ${JSON.stringify({
            human_review_reason: reason,
            human_review_requested_at: new Date().toISOString(),
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${runId}
    `;

    await sql`
      UPDATE research_stages
      SET status = 'waiting_for_human',
          updated_at = NOW()
      WHERE research_run_id = ${runId}
        AND status = 'running'
    `;
  } finally {
    await sql.end();
  }
}

/**
 * Mark a run as failed. Fails current stage and cancels pending.
 */
export async function failRun(
  runId: string,
  reason: string
): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    await sql`
      UPDATE research_runs
      SET status = 'failed',
          failure_reason = ${reason},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${runId}
    `;

    await sql`
      UPDATE research_stages
      SET status = 'failed',
          failure_reason = ${reason},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE research_run_id = ${runId}
        AND status IN ('running', 'waiting_for_human')
    `;

    await sql`
      UPDATE research_stages
      SET status = 'cancelled',
          failure_reason = ${`Run failed: ${reason}`},
          updated_at = NOW()
      WHERE research_run_id = ${runId}
        AND status = 'pending'
    `;
  } finally {
    await sql.end();
  }
}

/**
 * Mark a run as completed after running final validation.
 */
export async function completeRun(runId: string): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const validation = await validateCompletionCriteria(runId);

    if (!validation.valid) {
      throw new Error(
        `Cannot complete run — completion criteria not met: ${validation.errors.join("; ")}`
      );
    }

    await sql`
      UPDATE research_runs
      SET status = 'completed',
          completed_at = NOW(),
          updated_at = NOW(),
          metadata_json = metadata_json || ${JSON.stringify({
            completion_validation: validation,
          })}::jsonb
      WHERE id = ${runId}
    `;
  } finally {
    await sql.end();
  }
}
