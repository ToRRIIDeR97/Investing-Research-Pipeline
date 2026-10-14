import postgres from "postgres";
import { getReportState, loadReportInputs } from "@/lib/research/reporting/store";
import { assertReportApproval } from "@/lib/research/reporting/report";
import type { Sql } from "@/lib/research/run-context";
import { CURRENT_PIPELINE_VERSION } from "@/lib/research/version";
import { readyStages, dependentStages } from "@/lib/research/team-plan";
import { getStageOutputContract } from "@/lib/research/stage-contracts";
import { FOUNDER_GAP_ERROR } from "@/lib/research/handlers/evidence-extraction";
import { getTeamRequests, rerunRequestStages, skipRequestRerun } from "@/lib/research/team";
import { STAGE_CONFIGS, STAGE_CONFIG_MAP, getAllStagesForRun, getApplicableStages, getStageConfig } from "./stages";
import { evaluateResearchQuality } from "./quality-gates";
import {
  validateStageCompletion,
  validateSourceLinks,
  validateAssetProfile,
  validatePointInTime,
  validateCompletionCriteria,
  validateSourceDepth,
  validateAnalysisCoverage,
  validateValuationDepth,
  validateReviewOutcome,
  validateHumanReviewOutcome,
  ValidationResult,
} from "./validators";

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

export const HUMAN_REVIEW_STATUSES = new Set([
  "reject", "watchlist", "needs_more_work", "approved_for_tracking", "approved_for_position", "archived",
]);
export const HUMAN_APPROVAL_STATUSES = new Set(["approved_for_tracking", "approved_for_position"]);
export function isKnownHumanDecision(status: unknown) {
  return HUMAN_REVIEW_STATUSES.has(String(status || "").toLowerCase());
}
export function isApprovedHumanDecision(status: unknown) {
  return HUMAN_APPROVAL_STATUSES.has(String(status || "").toLowerCase());
}

/**
 * Create research_stages records for all stages including explicitly skipped ones.
 * §25.2: Skipped stages must be explicitly marked skipped with a reason.
 */
export async function createStagesForRun(runId: string): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const runs = await sql`
      SELECT id, run_type, pipeline_version FROM research_runs WHERE id = ${runId}
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
          ${sql.json({
            requiredOutputs: stage.requiredOutputs,
            requiresHumanApproval: stage.requiresHumanApproval,
            entryCriteria: stage.entryCriteria,
            validationRules: stage.validationRules,
            failureState: stage.failureState,
          })},
          ${sql.json({})}
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
          ${sql.json({
            requiredOutputs: stage.requiredOutputs,
            skipReason: stage.skipReason || `Skipped for run type: ${runType}`,
          })},
          ${sql.json({})},
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
  runId: string,
  handlerValidation?: ValidationResult,
  options: { stageKey?: string; deferNext?: boolean } = {}
): Promise<{ success: boolean; nextStage?: string; action?: string; error?: string }> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Find the current running stage
    const runningStages = await sql`
      SELECT id, stage_key, stage_order, max_retries, budget_limit_usd, validation_result_json
      FROM research_stages
      WHERE research_run_id = ${runId}
        AND status = 'running'
        AND (${options.stageKey || null}::text IS NULL OR stage_key = ${options.stageKey || null})
      ORDER BY stage_order ASC
      LIMIT 1
    `;

    if (runningStages.length === 0) {
      return { success: false, error: "No stage is currently running" };
    }

    const currentStage = runningStages[0];
    const config = getStageConfig(currentStage.stage_key);

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
          const next = options.deferNext ? undefined : await startNextStage(runId);
          return { success: true, nextStage: next, action: "skip_and_continue" };
        }
      }
    }

    // Validate stage completion

    let validation: ValidationResult = handlerValidation || { valid: true, errors: [], warnings: [], checkedAt: new Date().toISOString() };
    if (validation.valid) {
      validation = await validateStageCompletion(runId, currentStage.stage_key);
    }
    if (validation.valid && config?.validationRules && config.validationRules.length > 0) {
      for (const rule of config.validationRules) {
        let ruleResult: ValidationResult;
        switch (rule) {
          case "source_validation":
            ruleResult = await validateSourceDepth(runId);
            break;
          case "analysis_coverage_validation":
            ruleResult = await validateAnalysisCoverage(runId);
            break;
          case "valuation_depth_validation":
            ruleResult = await validateValuationDepth(runId);
            break;
          case "review_outcome_validation":
            ruleResult = await validateReviewOutcome(runId);
            break;
          case "human_review_validation":
            ruleResult = await validateHumanReviewOutcome(runId);
            break;
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
            ruleResult = {
              valid: false,
              errors: [`Unknown validation rule "${rule}" on stage "${currentStage.stage_key}"`],
              warnings: [],
              checkedAt: new Date().toISOString(),
            };
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
      const previousValidation =
        typeof currentStage.validation_result_json === "string"
          ? JSON.parse(currentStage.validation_result_json)
          : currentStage.validation_result_json;
      const retryCount = Number(previousValidation?.retryCount ?? 0);
      const maxRetries = currentStage.max_retries ?? 2;

      // Completed requests from an invalid stage must not bypass its next attempt. A founder-gap-only failure
      // reruns just the founder pass this attempt ran; the source-reader batches replay.
      const founderPassTaskKey = handlerValidation?.founderPassTaskKey;
      const founderGapOnly = currentStage.stage_key === "evidence_extraction" && !!founderPassTaskKey &&
        validation.errors.length > 0 && validation.errors.every((error) => error === FOUNDER_GAP_ERROR);
      const narrowed = founderGapOnly ? await sql`UPDATE research_tasks SET validation_status = 'invalid', updated_at = NOW()
        WHERE stage_id = ${currentStage.id} AND status = 'completed' AND task_type = 'evidence_extraction_role_gap'
          AND task_key = ${founderPassTaskKey!} AND validation_status IS DISTINCT FROM 'invalid' RETURNING id` : [];
      if (!narrowed.length) await sql`UPDATE research_tasks SET validation_status = 'invalid', updated_at = NOW()
        WHERE stage_id = ${currentStage.id} AND status = 'completed'`;
      const artifactTypes = getStageOutputContract(currentStage.stage_key)?.requiredKeys || [];
      if (artifactTypes.length) await sql`
        UPDATE research_artifacts SET status = 'needs_more_work', updated_at = NOW()
        WHERE research_run_id = ${runId} AND artifact_type = ANY(${artifactTypes}::text[])
          AND status = 'validated'
      `;
      if (retryCount < maxRetries) {
        const retryValidation = {
          ...validation,
          retryCount: retryCount + 1,
        };

        // Persist retry count in the validation payload; stage schema has no retry_count column.
        await sql`
          UPDATE research_stages
          SET validation_result_json = ${sql.json(retryValidation)},
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
              validation_result_json = ${sql.json(validation as any)},
              completed_at = NOW(),
              updated_at = NOW()
          WHERE id = ${currentStage.id}
        `;
        const next = options.deferNext ? undefined : await startNextStage(runId);
        return { success: true, nextStage: next, action: "skip_and_continue" };
      }
    }

    if (config?.requiresHumanApproval) {
      await pauseForHumanReview(runId, `Stage ${currentStage.stage_key} requires human approval`);
      return { success: true, action: "pause_for_human" };
    }

    // Validation passed — mark stage completed
    await sql`
      UPDATE research_stages
      SET status = 'completed',
          completed_at = NOW(),
          validation_result_json = ${sql.json(validation as any)},
          updated_at = NOW()
      WHERE id = ${currentStage.id}
    `;

    // Start next stage
    const next = options.deferNext ? undefined : await startNextStage(runId);
    return { success: true, nextStage: next, action: "continue" };
  } finally {
    await sql.end();
  }
}

/**
 * Approve the research plan human gate and resume the run.
 */
export async function approveResearchPlan(
  runId: string,
  approvedBy: string = "user"
): Promise<{ success: boolean; nextStage?: string; error?: string }> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const validation: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      checkedAt: new Date().toISOString(),
    };
    const transition = await sql.begin(async (tx) => {
      const stages = await tx`
        SELECT id, status FROM research_stages
        WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
        LIMIT 1 FOR UPDATE
      `;
      if (!stages[0]) return { success: false as const, error: "Research plan stage not found" };
      if (stages[0].status !== "waiting_for_human") {
        if (stages[0].status === "completed") return { success: true as const };
        return { success: false as const, error: `Research plan is not waiting for approval (status: ${stages[0].status})` };
      }
      const [plan] = await tx`
        SELECT id FROM research_artifacts WHERE research_run_id = ${runId}
          AND artifact_type = 'research_plan' AND status IN ('validated', 'accepted') LIMIT 1
      `;
      if (!plan) return { success: false as const, error: "A persisted research plan is required before approval" };
      await tx`
        UPDATE research_stages
        SET status = 'completed', completed_at = NOW(),
            validation_result_json = ${tx.json({ ...validation, approvedBy, approvalType: "research_plan" })},
            updated_at = NOW()
        WHERE id = ${stages[0].id}
      `;
      await tx`
        UPDATE research_runs
        SET status = 'running',
            metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${tx.json({
              research_plan_approved_by: approvedBy,
              research_plan_approved_at: new Date().toISOString(),
            })},
            updated_at = NOW()
        WHERE id = ${runId}
      `;
      return { success: true as const };
    });
    if (!transition.success) return transition;
  } finally {
    await sql.end();
  }

  const nextStage = await startNextStage(runId);
  return { success: true, nextStage };
}

/**
 * Approve the final human review gate and resume the run.
 */
export async function approveHumanReview(
  runId: string,
  reviewedBy: string = "user"
): Promise<{ success: boolean; nextStage?: string; error?: string }> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const validation: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      checkedAt: new Date().toISOString(),
    };
    const transition = await sql.begin(async (tx) => {
      await tx`SELECT id FROM research_runs WHERE id = ${runId} FOR UPDATE`;
      const stages = await tx`
        SELECT id, status FROM research_stages
        WHERE research_run_id = ${runId} AND stage_key = 'human_review'
        LIMIT 1 FOR UPDATE
      `;
      if (!stages[0]) return { success: false as const, error: "Human review stage not found" };
      if (stages[0].status !== "waiting_for_human") {
        return { success: false as const, error: `Human review is not waiting for approval (status: ${stages[0].status})` };
      }
      const decisions = await tx`
        SELECT id, status FROM review_decisions
        WHERE research_run_id = ${runId}
        ORDER BY reviewed_at DESC LIMIT 1
      `;
      if (!decisions[0] || !isApprovedHumanDecision(decisions[0].status)) {
        return { success: false as const, error: "A persisted approved human review decision is required before approving the human-review stage" };
      }
      const report = await getReportState(tx as unknown as Sql, runId);
      if (report.required) {
        if (!report.document || report.approval?.decision_id !== decisions[0].id) return { success: false as const, error: "Approval of the current report version is required" };
        const inputs = await loadReportInputs(tx as unknown as Sql, runId, report.cutoff);
        try { assertReportApproval(report.document, report.approval, inputs.input_hash); }
        catch (error) { return { success: false as const, error: String(error) }; }
      }
      await tx`
        UPDATE research_stages
        SET status = 'completed', completed_at = NOW(),
            validation_result_json = ${tx.json({ ...validation, reviewedBy, reviewDecisionId: decisions[0].id, approvalType: "human_review" })},
            updated_at = NOW()
        WHERE id = ${stages[0].id}
      `;
      await tx`
        UPDATE research_runs
        SET status = 'running',
            metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${tx.json({
              human_review_approved_by: reviewedBy,
              human_review_approved_at: new Date().toISOString(),
            })},
            updated_at = NOW()
        WHERE id = ${runId}
      `;
      return { success: true as const };
    });
    if (!transition.success) return transition;
  } finally {
    await sql.end();
  }

  const nextStage = await startNextStage(runId);
  return { success: true, nextStage };
}

/** The run is not paused on a request reset, or the decision is unknown. Nothing was changed. */
export class RequestResetError extends Error {}

/**
 * A reviewer's decision on a team-request re-run above the automatic limit. `rerun` reopens the recorded
 * stages; `skip` leaves them and turns the requests into open report questions. Neither touches the
 * research-plan or final-review gate, and an approved re-run does not use up the run's automatic one.
 */
export async function approveRequestReset(
  runId: string,
  input: { decision: "rerun" | "skip"; actor: string }
): Promise<{ decision: "rerun" | "skip"; stages: string[]; request_ids: string[] }> {
  if (input.decision !== "rerun" && input.decision !== "skip") throw new RequestResetError(`Unknown request-reset decision: ${String(input.decision)}`);
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    return await sql.begin(async (tx) => {
      const [run] = await tx`SELECT status, metadata_json FROM research_runs WHERE id = ${runId} FOR UPDATE`;
      const reset = run?.metadata_json?.request_reset as { stages: string[]; request_ids: string[] } | undefined;
      if (run?.status !== "waiting_for_human" || !reset) throw new RequestResetError("The run is not paused on a request reset");
      const gates = await tx`SELECT stage_key FROM research_stages WHERE research_run_id = ${runId}
        AND stage_key IN ('research_plan', 'human_review') AND status = 'waiting_for_human'`;
      if (gates.length) throw new RequestResetError(`The run is waiting at the ${gates[0].stage_key} gate`);
      const batch = await getTeamRequests(tx as unknown as Sql, runId);
      if (!batch) throw new RequestResetError("The run has no team requests");
      if (input.decision === "rerun") {
        await rerunRequestStages(tx as unknown as Sql, runId, batch, reset,
          `Superseded: its owning stage was reopened by a re-run approved for team request round ${batch.round}.`);
      } else {
        await skipRequestRerun(tx as unknown as Sql, runId, batch, reset.request_ids);
        await tx`UPDATE research_stages SET status = 'running', updated_at = NOW()
          WHERE research_run_id = ${runId} AND stage_key = 'ai_reviewer' AND status = 'waiting_for_human'`;
      }
      await tx`
        UPDATE research_runs
        SET status = 'running',
            metadata_json = ((CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) - 'request_reset') || ${tx.json({
              request_reset_decision: { decision: input.decision, actor: input.actor, stages: reset.stages, request_ids: reset.request_ids,
                decided_at: new Date().toISOString() },
            })},
            updated_at = NOW()
        WHERE id = ${runId}
      `;
      return { decision: input.decision, stages: reset.stages, request_ids: reset.request_ids };
    });
  } finally {
    await sql.end();
  }
}

/** Keep the plan gate actionable while persisting the requested changes. */
export async function requestResearchPlanChanges(
  runId: string,
  notes: string,
  requestedBy = "user"
): Promise<{ success: boolean; error?: string }> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    return await sql.begin(async (tx) => {
      const stages = await tx`
        SELECT id, status FROM research_stages
        WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
        LIMIT 1 FOR UPDATE
      `;
      if (!stages[0]) return { success: false, error: "Research plan stage not found" };
      if (stages[0].status !== "waiting_for_human") {
        return { success: false, error: `Research plan is not waiting for changes (status: ${stages[0].status})` };
      }
      await tx`
        UPDATE research_runs
        SET status = 'waiting_for_human',
            metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${tx.json({
              research_plan_change_request: notes.trim(),
              research_plan_change_requested_by: requestedBy,
              research_plan_change_requested_at: new Date().toISOString(),
            })}, updated_at = NOW()
        WHERE id = ${runId}
      `;
      return { success: true };
    });
  } finally {
    await sql.end();
  }
}

/**
 * Helper: start the next pending stage. Returns the stage key or undefined.
 */
export async function startNextStage(
  runId: string
): Promise<string | undefined> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const [runState] = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
    if (!runState || runState.status !== "running") return undefined;
    const failures = await sql`
      SELECT stage_key, failure_reason FROM research_stages
      WHERE research_run_id = ${runId} AND status = 'failed'
    `;
    const requiredFailure = failures.find((stage) =>
      getStageConfig(stage.stage_key)?.failureState === "fail_run" ||
      !String(stage.failure_reason).startsWith("Failed after")
    );
    if (requiredFailure) {
      await failRun(runId, `Run contains a failed stage (${requiredFailure.stage_key}): ${requiredFailure.failure_reason}`, "needs_more_work");
      return undefined;
    }
    const [active] = await sql`
      SELECT stage_key FROM research_stages
      WHERE research_run_id = ${runId} AND status IN ('running', 'waiting_for_human')
      ORDER BY stage_order LIMIT 1
    `;
    if (active) return active.stage_key;
    const nextStages = await sql`
      SELECT id, stage_key
      FROM research_stages
      WHERE research_run_id = ${runId}
        AND status = 'pending'
      ORDER BY stage_order ASC
      LIMIT 1
    `;
    if (nextStages.length === 0) {
      await completeRun(runId);
      return undefined;
    }

    const ledger = await sql`SELECT stage_key, status FROM research_stages WHERE research_run_id = ${runId} ORDER BY stage_order`;
    const ready = readyStages(ledger.map(s => ({ stage_key: String(s.stage_key), status: String(s.status) })));
    if (!ready.length) {
      // Name the failed stage that blocks the remaining work instead of a generic dependency error.
      const pending = new Set(ledger.filter(s => s.status === "pending").map(s => String(s.stage_key)));
      const blocker = failures.find(f => dependentStages([String(f.stage_key)]).some(key => pending.has(key)));
      if (!blocker) throw new Error("Pending research stages have unsatisfied dependencies");
      await failRun(runId, `Stage "${blocker.stage_key}" failed and blocks the remaining stages: ${blocker.failure_reason}`, "needs_more_work");
      return undefined;
    }
    const [nextStage] = await sql`SELECT id, stage_key FROM research_stages
      WHERE research_run_id = ${runId} AND stage_key = ${ready[0]}`;

    const runRows = await sql`
      SELECT run_type, asset_id
      FROM research_runs
      WHERE id = ${runId}
      LIMIT 1
    `;
    const run = runRows[0];
    const runType = run?.run_type;

    // Enforce entry criteria (stage dependencies are defined in the stage config)
    if (nextStage.stage_key === "asset_valuation") {
      // Valuation requires preceding operating_scenarios to be completed.
      const depStage = await sql`
        SELECT status FROM research_stages
        WHERE research_run_id = ${runId} AND stage_key = 'operating_scenarios'
        LIMIT 1
      `;
      if (!depStage[0] || depStage[0].status !== "completed") {
        await failRun(runId, "Asset valuation requires completed operating_scenarios stage.");
        return undefined;
      }
    }

    const config = getStageConfig(nextStage.stage_key);

    if (nextStage.stage_key === "human_review") {
      const failedRequiredStages = await sql`
        SELECT stage_key, failure_reason FROM research_stages
        WHERE research_run_id = ${runId} AND status = 'failed'
      `;
      if (failedRequiredStages.length) {
        await sql`
          UPDATE research_runs
          SET status = 'needs_more_work', completed_at = NOW(), updated_at = NOW(),
              failure_reason = ${`Cannot enter human review with failed stages: ${failedRequiredStages.map((stage) => stage.stage_key).join(", ")}`}
          WHERE id = ${runId}
        `;
        return undefined;
      }
    }

    if (config?.requiresHumanApproval && nextStage.stage_key !== "research_plan") {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE research_stages
          SET status = 'waiting_for_human',
              started_at = NOW(),
              updated_at = NOW()
          WHERE id = ${nextStage.id}
        `;
        await tx`
          UPDATE research_runs
          SET status = 'waiting_for_human',
              updated_at = NOW()
          WHERE id = ${runId}
        `;
      });
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

/** Claim every independent stage under the same run lock used by approvals. */
export async function startReadyStages(runId: string): Promise<string[]> {
  await startNextStage(runId);
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    return await sql.begin(async tx => {
      const [run] = await tx`SELECT status FROM research_runs WHERE id = ${runId} FOR UPDATE`;
      if (run?.status !== "running") return [];
      const stages = await tx`SELECT stage_key, status FROM research_stages WHERE research_run_id = ${runId} ORDER BY stage_order`;
      const keys = readyStages(stages.map(s => ({ stage_key: String(s.stage_key), status: String(s.status) })))
        .filter(key => key !== "human_review");
      if (keys.length) await tx`UPDATE research_stages SET status = 'running',
        started_at = COALESCE(started_at, NOW()), updated_at = NOW()
        WHERE research_run_id = ${runId} AND stage_key = ANY(${keys}::text[]) AND status = 'pending'`;
      return keys;
    });
  } finally { await sql.end(); }
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
    await sql.begin(async (tx) => {
      await tx`
        UPDATE research_runs
        SET status = 'waiting_for_human',
            metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${tx.json({
              human_review_reason: reason,
              human_review_requested_at: new Date().toISOString(),
            })},
            updated_at = NOW()
        WHERE id = ${runId}
      `;

      await tx`
        UPDATE research_stages
        SET status = 'waiting_for_human',
            updated_at = NOW()
        WHERE research_run_id = ${runId}
          AND status = 'running'
      `;
    });
  } finally {
    await sql.end();
  }
}

/**
 * Mark a run as failed. Fails current stage and cancels pending.
 */
export async function failRun(
  runId: string,
  reason: string,
  status: "failed" | "needs_more_work" = "failed"
): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // One transaction: a run marked failed with a stage still running cannot be resumed or re-queued.
    await sql.begin(async (tx) => {
      // A handler that ignores the abort signal may fail after its run was cancelled; cancelled stays final.
      const [updated] = await tx`
        UPDATE research_runs
        SET status = ${status},
            failure_reason = ${reason},
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${runId} AND status <> 'cancelled'
        RETURNING id
      `;
      if (!updated) return;

      await tx`
        UPDATE research_stages
        SET status = 'failed',
            failure_reason = ${reason},
            completed_at = NOW(),
            updated_at = NOW()
        WHERE research_run_id = ${runId}
          AND status IN ('running', 'waiting_for_human')
      `;

      await tx`
        UPDATE research_tasks
        SET status = 'failed',
            failure_reason = ${reason},
            completed_at = NOW(),
            updated_at = NOW()
        WHERE research_run_id = ${runId}
          AND status = 'running'
      `;

      await tx`
        UPDATE research_stages
        SET status = 'cancelled',
            failure_reason = ${`Run failed: ${reason}`},
            updated_at = NOW()
        WHERE research_run_id = ${runId}
          AND status = 'pending'
      `;
    });
  } finally {
    await sql.end();
  }
}

/**
 * Cancel a run. Cancelled is terminal: the run cannot be queued again. Its active job is closed, so a worker
 * executing it loses its lease at the next renewal and aborts the in-flight model call.
 */
export async function cancelRun(runId: string, actor = "user"): Promise<{ cancelled: boolean; status: string } | null> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    return await sql.begin(async (tx) => {
      const [run] = await tx`SELECT status FROM research_runs WHERE id = ${runId} FOR UPDATE`;
      if (!run) return null;
      if (run.status === "completed" || run.status === "cancelled") return { cancelled: false, status: String(run.status) };
      const reason = `Cancelled by ${actor}`;
      await tx`UPDATE research_runs SET status = 'cancelled', failure_reason = ${reason}, completed_at = NOW(), updated_at = NOW()
        WHERE id = ${runId}`;
      await tx`UPDATE research_stages SET status = 'cancelled', failure_reason = ${reason}, updated_at = NOW(),
          completed_at = CASE WHEN status = 'pending' THEN completed_at ELSE NOW() END
        WHERE research_run_id = ${runId} AND status IN ('pending', 'running', 'waiting_for_human')`;
      await tx`UPDATE research_tasks SET status = 'failed', failure_reason = ${reason}, completed_at = NOW(), updated_at = NOW()
        WHERE research_run_id = ${runId} AND status IN ('pending', 'running')`;
      await tx`UPDATE research_run_jobs SET status = 'failed', failure_reason = ${reason}, lease_owner = NULL,
          lease_expires_at = NULL, completed_at = NOW(), updated_at = NOW()
        WHERE research_run_id = ${runId} AND status IN ('queued', 'running')`;
      return { cancelled: true, status: "cancelled" };
    });
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
    const quality = await evaluateResearchQuality(runId);

    if (!validation.valid) {
      throw new Error(
        `Cannot complete run — completion criteria not met: ${validation.errors.join("; ")}`
      );
    }

    if (quality.status !== "pass") {
      await sql`
        UPDATE research_runs
        SET status = 'needs_more_work',
            completed_at = NOW(),
            updated_at = NOW(),
            metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${sql.json({
              completion_validation: validation as any,
              quality_gate: quality as any,
            })}
        WHERE id = ${runId}
      `;
      return;
    }

    await sql`
      UPDATE research_runs
      SET status = 'completed',
          completed_at = NOW(),
          updated_at = NOW(),
          metadata_json = (CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json ELSE '{}'::jsonb END) || ${sql.json({
            completion_validation: validation as any,
            quality_gate: quality as any,
          })}
      WHERE id = ${runId}
    `;
  } finally {
    await sql.end();
  }
}

export async function resumeResearchRun(runId: string) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    await sql.begin(async (tx) => {
      const [run] = await tx`SELECT status, pipeline_version FROM research_runs WHERE id = ${runId} FOR UPDATE`;
      if (!run || Number(run.pipeline_version) !== CURRENT_PIPELINE_VERSION || !["needs_more_work", "failed"].includes(run.status)) return;
      const active = await tx`SELECT id FROM research_run_jobs WHERE research_run_id = ${runId} AND status IN ('queued', 'running') LIMIT 1`;
      if (active.length) return;
      const stages = await tx`
        SELECT id, stage_key, stage_order, status FROM research_stages
        WHERE research_run_id = ${runId} AND status IN ('failed', 'running', 'waiting_for_human')
        ORDER BY stage_order
      `;
      if (!stages.length) throw new Error("Cannot resume: expected failed stages and no active stage");
      // A gate left open waits for its reviewer again; no handler can run human_review, so it is never restarted.
      const gate = stages[0].status === "waiting_for_human" || stages[0].stage_key === "human_review";
      // A stopped run cannot have active stages; these were left by an interrupted transition.
      const leftActive = stages.filter((stage, i) => stage.status !== "failed" && !(gate && i === 0)).map((stage) => String(stage.id));
      if (leftActive.length) await tx`
        UPDATE research_stages SET status = 'failed', failure_reason = 'Left active when the run stopped',
          completed_at = NOW(), updated_at = NOW()
        WHERE id = ANY(${leftActive}::uuid[])
      `;
      if (gate) await tx`
        UPDATE research_stages
        SET status = 'waiting_for_human', failure_reason = NULL, started_at = COALESCE(started_at, NOW()),
            completed_at = NULL, updated_at = NOW()
        WHERE id = ${stages[0].id}
      `;
      else await tx`
        UPDATE research_stages
        SET status = 'running', failure_reason = NULL, validation_result_json = NULL,
            started_at = NOW(), completed_at = NULL, updated_at = NOW()
        WHERE id = ${stages[0].id}
      `;
      await tx`
        UPDATE research_stages
        SET status = 'pending', failure_reason = NULL, started_at = NULL,
            completed_at = NULL, validation_result_json = NULL, updated_at = NOW()
        WHERE research_run_id = ${runId} AND stage_order > ${stages[0].stage_order}
          AND status IN ('failed', 'cancelled')
      `;
      await tx`
        UPDATE research_runs
        SET status = ${gate ? "waiting_for_human" : "running"}, failure_reason = NULL, completed_at = NULL, updated_at = NOW()
        WHERE id = ${runId}
      `;
    });
  } finally {
    await sql.end();
  }
}
