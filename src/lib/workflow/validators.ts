import postgres from "postgres";
import { STAGE_CONFIG_MAP } from "./stages";

// ============================================================
// Validators — deterministic checks on stage / run completion.
// These are application-level rules, not AI judgments.
// ============================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checkedAt: string;
}

/**
 * Validate that a stage's required outputs exist and pass
 * stage-specific checks.
 */
export async function validateStageCompletion(
  runId: string,
  stageKey: string
): Promise<ValidationResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const config = STAGE_CONFIG_MAP[stageKey];
    if (!config) {
      return {
        valid: false,
        errors: [`Unknown stage key: ${stageKey}`],
        warnings: [],
        checkedAt: new Date().toISOString(),
      };
    }

    // Fetch the run to know asset_id and profile
    const runs = await sql`
      SELECT id, asset_id, run_type, profile_id
      FROM research_runs
      WHERE id = ${runId}
    `;
    if (runs.length === 0) {
      return {
        valid: false,
        errors: [`Research run not found: ${runId}`],
        warnings: [],
        checkedAt: new Date().toISOString(),
      };
    }
    const run = runs[0];

    // Stage-specific output checks
    for (const output of config.requiredOutputs) {
      switch (output) {
        case "profile_assignment": {
          const rows = await sql`
            SELECT id FROM asset_profile_assignments
            WHERE asset_id = ${run.asset_id}
              AND (research_run_id = ${runId} OR research_run_id IS NULL)
              AND status = 'active'
            LIMIT 1
          `;
          if (rows.length === 0) {
            errors.push("No active profile assignment found for asset");
          }
          break;
        }

        case "research_plan_json": {
          const rows = await sql`
            SELECT stage_key, completion_criteria_json
            FROM research_stages
            WHERE research_run_id = ${runId} AND stage_key = 'research_plan'
          `;
          if (rows.length === 0 || !rows[0].completion_criteria_json) {
            errors.push("Research plan JSON not found in stage completion criteria");
          }
          break;
        }

        case "source_inventory": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM source_documents
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No source documents ingested for this run");
          }
          break;
        }

        case "source_gaps": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM source_gaps
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            warnings.push(
              "No source gaps recorded — this may indicate gaps were not assessed"
            );
          }
          break;
        }

        case "parsed_documents": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM document_parses dp
            JOIN source_documents sd ON dp.source_document_id = sd.id
            WHERE sd.research_run_id = ${runId}
              AND dp.status = 'completed'
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No completed document parses for this run");
          }
          break;
        }

        case "evidence_claims": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM evidence_claims
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No evidence claims extracted for this run");
          }
          break;
        }

        case "metric_observations": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM metric_observations
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No metric observations recorded for this run");
          }
          break;
        }

        case "analysis_sections": {
          // Analysis sections stored as tasks with task_type = 'analysis'
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM research_tasks
            WHERE research_run_id = ${runId}
              AND task_type = 'analysis'
              AND status = 'completed'
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No completed analysis tasks for this run");
          }
          break;
        }

        case "valuation_signals": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM valuation_signals
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No valuation signals generated for this run");
          }
          break;
        }

        case "scenarios": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM scenarios
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No scenarios generated for this run");
          }
          break;
        }

        case "thesis": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM theses
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No thesis created for this run");
          }
          break;
        }

        case "risks": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM risks
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No risks documented for this run");
          }
          break;
        }

        case "catalysts": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM catalysts
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No catalysts documented for this run");
          }
          break;
        }

        case "review_findings": {
          const rows = await sql`
            SELECT output_json FROM research_tasks
            WHERE research_run_id = ${runId}
              AND task_type = 'ai_review'
              AND status = 'completed'
          `;
          if (rows.length === 0) {
            errors.push("AI reviewer has not produced review findings");
          }
          break;
        }

        case "backtest_results": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM backtest_runs
            WHERE research_run_id = ${runId}
              AND status = 'completed'
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No completed backtest results found for this run");
          }
          break;
        }

        case "export_artifact": {
          const rows = await sql`
            SELECT COUNT(*) as cnt FROM exports
            WHERE research_run_id = ${runId}
          `;
          if (Number(rows[0].cnt) === 0) {
            errors.push("No export artifact generated for this run");
          }
          break;
        }

        default:
          warnings.push(`No validation rule registered for output: ${output}`);
      }
    }

    const result: ValidationResult = {
      valid: errors.length === 0,
      errors,
      warnings,
      checkedAt: new Date().toISOString(),
    };

    // Persist validation result on the stage record
    await sql`
      UPDATE research_stages
      SET validation_result_json = ${JSON.stringify(result)}::jsonb,
          updated_at = NOW()
      WHERE research_run_id = ${runId} AND stage_key = ${stageKey}
    `;

    return result;
  } finally {
    await sql.end();
  }
}

/**
 * Validate that all accepted evidence claims have source links,
 * unless the claim is an assumption or carries an explicit
 * no_source_reason.
 */
export async function validateSourceLinks(
  runId: string
): Promise<ValidationResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Find claims that lack source links and are not assumptions / no_source_reason
    const unlinked = await sql`
      SELECT ec.id, ec.claim_text, ec.claim_category, ec.no_source_reason
      FROM evidence_claims ec
      LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
      WHERE ec.research_run_id = ${runId}
        AND ec.claim_category != 'assumption'
        AND ec.no_source_reason IS NULL
        AND el.id IS NULL
    `;

    for (const claim of unlinked) {
      errors.push(
        `Claim ${claim.id} ("${String(claim.claim_text).slice(0, 60)}...") has no source link, no_source_reason is null, and category is not assumption`
      );
    }

    // Warn about assumptions that have no source (acceptable but worth noting)
    const assumptionsNoSource = await sql`
      SELECT ec.id, ec.claim_text
      FROM evidence_claims ec
      LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
      WHERE ec.research_run_id = ${runId}
        AND ec.claim_category = 'assumption'
        AND ec.no_source_reason IS NULL
        AND el.id IS NULL
    `;

    for (const claim of assumptionsNoSource) {
      warnings.push(
        `Assumption ${claim.id} ("${String(claim.claim_text).slice(0, 60)}...") has no source link or no_source_reason`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await sql.end();
  }
}

/**
 * Validate the asset profile constraints:
 * - Forbidden methods were not used in valuation signals
 * - Required modules were attempted (tasks exist)
 * - Required valuation lenses have signals
 */
export async function validateAssetProfile(
  runId: string
): Promise<ValidationResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Get run + profile
    const runs = await sql`
      SELECT rr.asset_id, rr.profile_id
      FROM research_runs rr
      WHERE rr.id = ${runId}
    `;
    if (runs.length === 0 || !runs[0].profile_id) {
      return {
        valid: false,
        errors: ["Run not found or no profile assigned"],
        warnings: [],
        checkedAt: new Date().toISOString(),
      };
    }
    const { profile_id } = runs[0];

    // Fetch profile config
    const profiles = await sql`
      SELECT
        required_modules_json,
        forbidden_methods_json,
        required_valuation_lenses_json
      FROM research_profiles
      WHERE id = ${profile_id}
    `;
    if (profiles.length === 0) {
      return {
        valid: false,
        errors: [`Profile not found: ${profile_id}`],
        warnings: [],
        checkedAt: new Date().toISOString(),
      };
    }

    const profile = profiles[0];
    const requiredModules: string[] =
      (profile.required_modules_json as string[]) || [];
    const forbiddenMethods: string[] =
      (profile.forbidden_methods_json as string[]) || [];
    const requiredLenses: string[] =
      (profile.required_valuation_lenses_json as string[]) || [];

    // Check forbidden methods are not used in valuation signals
    // §28.2: Forbidden methods should be recorded as not_applicable with reason,
    // not used as actual valuation signals. Only flag actual usage, not not_applicable.
    if (forbiddenMethods.length > 0) {
      const methodRows = await sql`
        SELECT DISTINCT vm.method_key, vs.signal
        FROM valuation_signals vs
        JOIN valuation_methods vm ON vs.valuation_method_id = vm.id
        WHERE vs.research_run_id = ${runId}
          AND vs.signal != 'not_applicable'
      `;
      const usedMethods = new Set(methodRows.map((r) => r.method_key));
      for (const forbidden of forbiddenMethods) {
        if (usedMethods.has(forbidden)) {
          errors.push(
            `Forbidden valuation method "${forbidden}" was actually used (not marked not_applicable) in this run`
          );
        }
      }
    }

    // Check required modules — at least one task per module should exist
    if (requiredModules.length > 0) {
      const taskRows = await sql`
        SELECT DISTINCT task_key
        FROM research_tasks
        WHERE research_run_id = ${runId}
          AND status IN ('completed', 'running', 'pending')
      `;
      const attemptedModules = new Set(taskRows.map((r) => r.task_key));
      for (const mod of requiredModules) {
        if (!attemptedModules.has(mod)) {
          errors.push(`Required module "${mod}" has no task created for this run`);
        }
      }
    }

    // Check required valuation lenses have signals
    if (requiredLenses.length > 0) {
      const lensRows = await sql`
        SELECT DISTINCT lens_family
        FROM valuation_signals
        WHERE research_run_id = ${runId}
      `;
      const coveredLenses = new Set(lensRows.map((r) => r.lens_family));
      for (const lens of requiredLenses) {
        if (!coveredLenses.has(lens)) {
          errors.push(
            `Required valuation lens "${lens}" has no valuation signals for this run`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await sql.end();
  }
}

/**
 * End-to-end completion check:
 * - All required stages are in completed status
 * - Expected artifacts exist
 * - Source gaps are recorded
 */
export async function validateCompletionCriteria(
  runId: string
): Promise<ValidationResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Get run type
    const runs = await sql`
      SELECT run_type FROM research_runs WHERE id = ${runId}
    `;
    if (runs.length === 0) {
      return {
        valid: false,
        errors: [`Run not found: ${runId}`],
        warnings: [],
        checkedAt: new Date().toISOString(),
      };
    }

    // All non-skipped stages must be completed
    const incompleteStages = await sql`
      SELECT stage_key, status
      FROM research_stages
      WHERE research_run_id = ${runId}
        AND status NOT IN ('completed', 'skipped')
      ORDER BY stage_order
    `;

    for (const stage of incompleteStages) {
      errors.push(
        `Stage "${stage.stage_key}" is not complete (status: ${stage.status})`
      );
    }

    // Check that key artifacts exist
    // Evidence claims
    const claimCount = await sql`
      SELECT COUNT(*) as cnt FROM evidence_claims
      WHERE research_run_id = ${runId}
    `;
    if (Number(claimCount[0].cnt) === 0) {
      errors.push("No evidence claims exist for this run");
    }

    // Metric observations
    const metricCount = await sql`
      SELECT COUNT(*) as cnt FROM metric_observations
      WHERE research_run_id = ${runId}
    `;
    if (Number(metricCount[0].cnt) === 0) {
      warnings.push("No metric observations exist for this run");
    }

    // Thesis
    const thesisCount = await sql`
      SELECT COUNT(*) as cnt FROM theses
      WHERE research_run_id = ${runId}
    `;
    if (Number(thesisCount[0].cnt) === 0) {
      errors.push("No thesis exists for this run");
    }

    // Source gaps should be recorded
    const gapCount = await sql`
      SELECT COUNT(*) as cnt FROM source_gaps
      WHERE research_run_id = ${runId}
    `;
    if (Number(gapCount[0].cnt) === 0) {
      warnings.push(
        "No source gaps recorded — source gap assessment may not have been performed"
      );
    }

    // Export artifact should exist
    const exportCount = await sql`
      SELECT COUNT(*) as cnt FROM exports
      WHERE research_run_id = ${runId}
    `;
    if (Number(exportCount[0].cnt) === 0) {
      errors.push("No export artifact exists for this run");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await sql.end();
  }
}

/**
 * Point-in-time validation — §28.3
 * Ensures backtest inputs don't use future data.
 * Checks:
 * - available_at is not after the market_data_cutoff_at
 * - Revised values are handled explicitly
 * - Market data cutoff is recorded
 * - Data provider is recorded for metric observations
 */
export async function validatePointInTime(
  runId: string
): Promise<ValidationResult> {
  const sql = postgres(process.env.DATABASE_URL!);
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Get the run's market data cutoff
    const runs = await sql`
      SELECT market_data_cutoff_at, source_cutoff_at
      FROM research_runs WHERE id = ${runId}
    `;
    if (runs.length === 0) {
      return {
        valid: false,
        errors: [`Run not found: ${runId}`],
        warnings: [],
        checkedAt: new Date().toISOString(),
      };
    }

    const run = runs[0];

    // Check market data cutoff is recorded
    if (!run.market_data_cutoff_at) {
      warnings.push(
        "market_data_cutoff_at is not set — point-in-time compliance cannot be fully verified"
      );
    }

    // Check metric observations don't use data after the cutoff
    if (run.market_data_cutoff_at) {
      const futureData = await sql`
        SELECT id, metric_definition_id, available_at, as_of_date
        FROM metric_observations
        WHERE research_run_id = ${runId}
          AND available_at IS NOT NULL
          AND available_at > ${run.market_data_cutoff_at}
      `;

      for (const obs of futureData) {
        errors.push(
          `Metric observation ${obs.id} has available_at (${obs.available_at}) after market_data_cutoff_at (${run.market_data_cutoff_at})`
        );
      }

      const futureBacktests = await sql`
        SELECT id, symbol, end_date
        FROM backtest_runs
        WHERE research_run_id = ${runId}
          AND end_date IS NOT NULL
          AND end_date::timestamp > ${run.market_data_cutoff_at}
      `;

      for (const backtest of futureBacktests) {
        errors.push(
          `Backtest ${backtest.id} (${backtest.symbol}) ends at ${backtest.end_date}, after market_data_cutoff_at (${run.market_data_cutoff_at})`
        );
      }
    }

    // Check that metric observations with available_at have data_provider
    const noProvider = await sql`
      SELECT id, metric_definition_id
      FROM metric_observations
      WHERE research_run_id = ${runId}
        AND available_at IS NOT NULL
        AND (data_provider IS NULL OR data_provider = '')
    `;

    for (const obs of noProvider) {
      warnings.push(
        `Metric observation ${obs.id} has available_at but no data_provider — lineage is incomplete`
      );
    }

    const backtestsWithoutProvider = await sql`
      SELECT id, symbol
      FROM backtest_runs
      WHERE research_run_id = ${runId}
        AND (data_provider IS NULL OR data_provider = '')
    `;

    for (const backtest of backtestsWithoutProvider) {
      warnings.push(
        `Backtest ${backtest.id} (${backtest.symbol}) has no data_provider — lineage is incomplete`
      );
    }

    // Check revised values are handled
    const revisedObs = await sql`
      SELECT id, metric_definition_id, is_revised, revision_number, supersedes_id
      FROM metric_observations
      WHERE research_run_id = ${runId}
        AND is_revised = true
        AND supersedes_id IS NULL
    `;

    for (const obs of revisedObs) {
      warnings.push(
        `Metric observation ${obs.id} is marked as revised but has no supersedes_id — revision lineage is broken`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await sql.end();
  }
}
