import postgres from "postgres";
import { pipelineSql } from "@/db/pipeline-sql";
import { STAGE_OUTPUT_CONTRACTS } from "@/lib/research/stage-contracts";
import { canonicalResearchKey, contractForProfile, sourceFamiliesPresent } from "@/lib/research/v2-contracts";
import { withheldValuationReason } from "@/lib/research/valuation/contracts";

type Row = Record<string, any>;

export interface MissingCoverageItem {
  key: string;
  severity: "low" | "medium" | "high" | "critical";
  area: string;
  description: string;
  requiredForCompletion: boolean;
}

export interface ResearchQualityGateResult {
  status: "pass" | "needs_more_work" | "fail";
  actionReadiness:
    | "triage_only"
    | "research_scaffold"
    | "review_ready"
    | "investment_ready";
  errors: string[];
  warnings: string[];
  missingCoverage: MissingCoverageItem[];
  counts: {
    sources: number;
    evidence: number;
    metrics: number;
    valuationSignals: number;
    scenarios: number;
    scenariosWithValueAnchors: number;
    openSourceGaps: number;
    reviewDecisions: number;
  };
}

interface RunQualityData {
  run: Row;
  asset?: Row;
  profile?: Row;
  stages: Row[];
  tasks: Row[];
  artifacts?: Row[];
  sources: Row[];
  evidence: Row[];
  metrics: Row[];
  signals: Row[];
  scenarios: Row[];
  sourceGaps: Row[];
  reviewDecisions: Row[];
  analysisSections: Row[];
  valuationModels: Row[];
  indicators: Row[];
  combinations: Row[];
  backtests: Row[];
  backtestArtifacts: Row[];
  unlinkedFactClaimCount: number;
}

interface RunTypeThreshold {
  minSources: number;
  minEvidenceClaims: number;
  requireValueAnchors: boolean;
  requireHumanReview: boolean;
}

export const RUN_TYPE_THRESHOLDS: Record<string, RunTypeThreshold> = {
  quick_scan: {
    minSources: 1,
    minEvidenceClaims: 5,
    requireValueAnchors: false,
    requireHumanReview: false,
  },
  deep_dive: {
    minSources: 5,
    minEvidenceClaims: 25,
    requireValueAnchors: true,
    requireHumanReview: true,
  },
  full_initiation_report: {
    minSources: 8,
    minEvidenceClaims: 40,
    requireValueAnchors: true,
    requireHumanReview: true,
  },
  valuation_refresh: {
    minSources: 2,
    minEvidenceClaims: 10,
    requireValueAnchors: true,
    requireHumanReview: true,
  },
  thesis_investigation: {
    minSources: 2,
    minEvidenceClaims: 8,
    requireValueAnchors: false,
    requireHumanReview: true,
  },
  source_update: {
    minSources: 1,
    minEvidenceClaims: 0,
    requireValueAnchors: false,
    requireHumanReview: false,
  },
};

const REJECTING_REVIEW_STATUSES = new Set([
  "needs_more_work",
  "reject",
  "rejected",
  "archived",
]);
const KNOWN_REVIEW_STATUSES = new Set([
  ...REJECTING_REVIEW_STATUSES,
  "watchlist",
  "approved_for_tracking",
  "approved_for_position",
]);

/** Runs on `client` when given (the API routes pass theirs), otherwise on the pipeline's shared pool. */
export async function evaluateResearchQuality(
  runId: string,
  client?: ReturnType<typeof postgres>
): Promise<ResearchQualityGateResult> {
  return evaluateLoadedResearchQuality(await loadRunQualityData(client ?? pipelineSql(), runId));
}

/**
 * Coverage key for anchor gaps caused by a deliberately withheld valuation. The valuation stage
 * accepts it (the run continues to synthesis, review and export); completion still fails on it.
 */
export const VALUATION_WITHHELD_KEY = "valuation_withheld";

export function valuationWithheld(artifacts: Row[] = []): string | null {
  const set = artifacts.find((artifact) => artifact.artifact_type === "valuation_scenario_set"
    && ["validated", "accepted"].includes(String(artifact.status)));
  return set ? withheldValuationReason(set.content_json) : null;
}

export function inferMissingSourceCoverage(input: {
  runType?: string;
  sources: Row[];
  evidence: Row[];
  scenarios: Row[];
  backtestArtifacts?: Row[];
  backtests?: Row[];
  valuationWithheldReason?: string | null;
}): MissingCoverageItem[] {
  const runType = input.runType || "deep_dive";
  const threshold = thresholdFor(runType);
  const gaps: MissingCoverageItem[] = [];

  if (input.sources.length < threshold.minSources) {
    gaps.push({
      key: "source_breadth",
      severity: threshold.minSources >= 5 ? "high" : "medium",
      area: "source breadth",
      description: `Only ${input.sources.length} source document(s) recorded; ${runType.replace(
        /_/g,
        " "
      )} requires at least ${threshold.minSources}.`,
      requiredForCompletion: runType !== "quick_scan",
    });
  }

  if (!hasSource(input.sources, ["sec", "filing", "10-k", "10-q", "20-f", "40-f", "6-k", "annual report", "quarterly report"])) {
    gaps.push({
      key: "formal_reporting_source",
      severity: runType === "quick_scan" ? "medium" : "high",
      area: "formal reporting",
      description:
        "No filing, annual report, quarterly report, or equivalent formal issuer source is recorded.",
      requiredForCompletion: runType !== "quick_scan",
    });
  }

  if (!hasSource(input.sources, ["investor", "ir", "earnings", "presentation", "transcript"])) {
    gaps.push({
      key: "investor_relations_source",
      severity: runType === "quick_scan" ? "medium" : "high",
      area: "company investor relations",
      description:
        "No investor-relations, earnings presentation, or transcript source is recorded.",
      requiredForCompletion: runType !== "quick_scan",
    });
  }

  if (!hasSource(input.sources, ["peer", "industry", "sector", "fdic", "fred", "federal reserve", "macro"])) {
    gaps.push({
      key: "peer_industry_context",
      severity: "medium",
      area: "industry and peer context",
      description:
        "No peer, industry, macro, or asset-class context source is recorded.",
      requiredForCompletion: runType !== "quick_scan",
    });
  }

  if (input.evidence.length < threshold.minEvidenceClaims) {
    gaps.push({
      key: "evidence_depth",
      severity: threshold.minEvidenceClaims >= 25 ? "high" : "medium",
      area: "evidence depth",
      description: `Only ${input.evidence.length} evidence claim(s) are recorded; ${runType.replace(
        /_/g,
        " "
      )} requires at least ${threshold.minEvidenceClaims}.`,
      requiredForCompletion: threshold.minEvidenceClaims > 0,
    });
  }

  if (threshold.requireValueAnchors && !input.scenarios.some((scenario) => numericLike(scenario.value_anchor))) {
    gaps.push({
      key: input.valuationWithheldReason ? VALUATION_WITHHELD_KEY : "valuation_anchors",
      severity: "high",
      area: "valuation anchors",
      description: input.valuationWithheldReason
        ? `Valuation withheld by the valuation analyst, so upside/downside cannot be assessed: ${input.valuationWithheldReason}`
        : "No numeric scenario value anchors are populated, so upside/downside cannot be assessed.",
      requiredForCompletion: true,
    });
  }

  if ((input.backtests?.length || 0) > 0 && (input.backtestArtifacts?.length || 0) === 0) {
    gaps.push({
      key: "backtest_artifacts",
      severity: "medium",
      area: "backtest artifacts",
      description:
        "Backtest run exists, but no artifact records are attached for metrics, equity curve, trades, or generated code.",
      requiredForCompletion: false,
    });
  }

  return gaps;
}

export function evaluateLoadedResearchQuality(data: RunQualityData): ResearchQualityGateResult {
  const threshold = thresholdFor(data.run.run_type);
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingCoverage: MissingCoverageItem[] = [];
  const openSourceGaps = data.sourceGaps.filter((gap) => isOpenGap(gap));
  const scenariosWithValueAnchors = data.scenarios.filter((scenario) =>
    numericLike(scenario.value_anchor)
  );
  const valuationWithheldReason = valuationWithheld(data.artifacts);
  const inferredGaps = inferMissingSourceCoverage({
    valuationWithheldReason,
    runType: data.run.run_type,
    sources: data.sources,
    evidence: data.evidence,
    scenarios: data.scenarios,
  });

  missingCoverage.push(...inferredGaps);

  if (data.sources.length < threshold.minSources) {
    errors.push(
      `Source depth is too thin: ${data.sources.length}/${threshold.minSources} required source documents.`
    );
  }

  if (data.evidence.length < threshold.minEvidenceClaims) {
    errors.push(
      `Evidence depth is too thin: ${data.evidence.length}/${threshold.minEvidenceClaims} required evidence claims.`
    );
  }

  if (!data.sources.length) {
    errors.push("No source documents are attached to this run.");
  }

  const unscoredSources = data.sources.filter((source) => source.source_quality_score == null);
  if (unscoredSources.length > 0) {
    warnings.push(`${unscoredSources.length} source document(s) have no quality score.`);
  }

  if (openSourceGaps.some((gap) => ["high", "critical"].includes(String(gap.severity)))) {
    missingCoverage.push(
      ...openSourceGaps
        .filter((gap) => ["high", "critical"].includes(String(gap.severity)))
        .map((gap) => ({
          key: String(gap.gap_key || gap.id),
          severity: normalizeSeverity(gap.severity),
          area: "recorded source gap",
          description: String(gap.description),
          requiredForCompletion: data.run.run_type !== "quick_scan",
        }))
    );
  }

  addAnalysisCoverage(data, errors, warnings, missingCoverage);
  addValuationCoverage(
    data,
    threshold,
    scenariosWithValueAnchors.length,
    errors,
    warnings,
    missingCoverage
  );
  addAiReviewCoverage(data, errors, warnings, missingCoverage);
  addHumanReviewCoverage(data, threshold, errors, warnings, missingCoverage);
  if (Number(data.run.pipeline_version || 1) >= 3) {
    addV3ArtifactCoverage(data, errors, missingCoverage);
  } else {
    addV2ArtifactCoverage(data, errors, missingCoverage);
  }

  const blockingMissingCoverage = missingCoverage.filter(
    (item) => item.requiredForCompletion && ["high", "critical"].includes(item.severity)
  );
  // Only required high/critical gaps (and errors) block; the rest stay in missingCoverage and are reported as warnings.
  for (const item of missingCoverage) {
    if (!blockingMissingCoverage.includes(item) && !errors.includes(item.description) && !warnings.includes(item.description)) {
      warnings.push(item.description);
    }
  }
  const hasFailures = errors.length > 0 || blockingMissingCoverage.length > 0;
  const status: ResearchQualityGateResult["status"] = hasFailures ? "needs_more_work" : "pass";
  const actionReadiness = actionReadinessFor(data, threshold, status);

  return {
    status,
    actionReadiness,
    errors,
    warnings,
    missingCoverage,
    counts: {
      sources: data.sources.length,
      evidence: data.evidence.length,
      metrics: data.metrics.length,
      valuationSignals: data.signals.length,
      scenarios: data.scenarios.length,
      scenariosWithValueAnchors: scenariosWithValueAnchors.length,
      openSourceGaps: openSourceGaps.length,
      reviewDecisions: data.reviewDecisions.length,
    },
  };
}

export async function loadRunQualityData(
  sql: ReturnType<typeof postgres>,
  runId: string
): Promise<RunQualityData> {
  const [run] = await sql`SELECT * FROM research_runs WHERE id = ${runId}`;
  if (!run) throw new Error(`Research run not found: ${runId}`);

  const [asset] = await sql`SELECT * FROM assets WHERE id = ${run.asset_id}`;
  const [profile] = run.profile_id
    ? await sql`SELECT * FROM research_profiles WHERE id = ${run.profile_id}`
    : [];

  const [
    stages,
    tasks,
    sources,
    evidence,
    metrics,
    signals,
    scenarios,
    sourceGaps,
    reviewDecisions,
    analysisSections,
    valuationModels,
    indicators,
    combinations,
    backtests,
    backtestArtifacts,
    unlinkedFactClaims,
    artifactHeads,
  ] = await Promise.all([
    // Only the columns the gates read: these tables carry large JSON bodies that the gates never use.
    sql`SELECT stage_key, status FROM research_stages WHERE research_run_id = ${runId} ORDER BY stage_order`,
    // Never input_json (the stored packets). v3 gates read only the latest completed AI review task;
    // earlier pipelines also match analysis modules against task outputs.
    Number(run.pipeline_version || 1) >= 3
      ? sql`SELECT id, task_key, task_type, status, output_json, created_at FROM research_tasks
          WHERE research_run_id = ${runId} AND task_type = 'ai_review' AND status = 'completed'
          ORDER BY created_at DESC LIMIT 1`
      : sql`SELECT id, stage_id, task_key, task_type, agent_name, status, priority, output_json, validation_status,
          validation_result_json, retry_count, started_at, completed_at, failure_reason, created_at
          FROM research_tasks WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`
      SELECT DISTINCT sd.*
      FROM source_documents sd
      LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
      WHERE sd.research_run_id = ${runId} OR rrs.research_run_id = ${runId}
      ORDER BY sd.created_at DESC
    `,
    sql`SELECT id, claim_text FROM evidence_claims WHERE research_run_id = ${runId} AND review_status != 'rejected' ORDER BY created_at DESC`,
    sql`
      SELECT mo.value_text, mo.review_status, md.metric_key, md.display_name
      FROM metric_observations mo
      JOIN metric_definitions md ON md.id = mo.metric_definition_id
      WHERE mo.research_run_id = ${runId}
      ORDER BY mo.created_at DESC
    `,
    sql`SELECT lens_family, signal, current_value_text, metadata_json FROM valuation_signals WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`SELECT scenario_type, value_anchor, valuation_model_run_id FROM scenarios WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`SELECT * FROM source_gaps WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`SELECT * FROM review_decisions WHERE research_run_id = ${runId} ORDER BY reviewed_at DESC`,
    sql`SELECT * FROM analysis_sections WHERE research_run_id = ${runId} ORDER BY module_key`,
    sql`SELECT * FROM valuation_model_runs WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`SELECT * FROM indicator_definitions WHERE research_run_id = ${runId} ORDER BY indicator_key`,
    sql`SELECT * FROM strategy_combinations WHERE research_run_id = ${runId} ORDER BY combination_key`,
    sql`SELECT id, metrics_json FROM backtest_runs WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`SELECT id FROM backtest_artifacts WHERE research_run_id = ${runId} ORDER BY created_at DESC`,
    sql`
      SELECT COUNT(*) AS cnt
      FROM evidence_claims ec
      LEFT JOIN evidence_links el ON el.evidence_claim_id = ec.id
      WHERE ec.research_run_id = ${runId}
        AND ec.claim_category = 'fact'
        AND ec.review_status != 'rejected'
        AND el.id IS NULL
    `,
    // Bodies run to megabytes per run and the run page polls these gates. Only the valuation set's body is always
    // read (for a withheld valuation); the rest are loaded below only when module coverage has to search them.
    sql`SELECT artifact_type, status,
        CASE WHEN artifact_type = 'valuation_scenario_set' THEN content_json END AS content_json
      FROM research_artifacts
      WHERE research_run_id = ${runId} AND status IN ('validated', 'accepted')`,
  ]);

  let artifacts = artifactHeads;
  if (Number(run.pipeline_version || 1) >= 3) {
    const modules = requiredAnalysisModules(profile);
    if (modules.length && modulesUncoveredByName({ evidence, metrics }, modules, analysisOutputs({ run, artifacts, tasks })).length) {
      artifacts = await sql`SELECT artifact_type, status, content_json FROM research_artifacts
        WHERE research_run_id = ${runId} AND status IN ('validated', 'accepted')`;
    }
  }

  return {
    run,
    asset,
    profile,
    stages,
    tasks,
    sources: sources.filter(isSubstantiveSource),
    evidence,
    metrics,
    signals,
    scenarios,
    sourceGaps,
    reviewDecisions,
    analysisSections,
    valuationModels,
    indicators,
    combinations,
    backtests,
    backtestArtifacts,
    artifacts,
    unlinkedFactClaimCount: Number(unlinkedFactClaims[0]?.cnt || 0),
  };
}

function addV3ArtifactCoverage(data: RunQualityData, errors: string[], missingCoverage: MissingCoverageItem[]) {
  if (!["deep_dive", "full_initiation_report"].includes(data.run.run_type)) return;
  const available = new Set((data.artifacts || [])
    .filter((artifact) => ["validated", "accepted"].includes(artifact.status))
    .map((artifact) => artifact.artifact_type));
  for (const [stage, contract] of Object.entries(STAGE_OUTPUT_CONTRACTS)) {
    if (stage === "ai_reviewer") continue;
    for (const key of contract.requiredKeys) {
      if (available.has(key)) continue;
      const label = key.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
      const description = `Required v3 ${label} artifact is missing or incomplete.`;
      errors.push(description);
      missingCoverage.push({ key: `v3_${key}`, area: key, description, severity: "high", requiredForCompletion: true });
    }
  }
}

function addV2ArtifactCoverage(
  data: RunQualityData,
  errors: string[],
  missingCoverage: MissingCoverageItem[]
) {
  if (Number(data.run.pipeline_version || 1) < 2 || data.run.run_type === "quick_scan") return;
  const contract = contractForProfile(String(data.profile?.profile_key || ""), String(data.asset?.slug || ""));
  if (!contract) {
    errors.push("Research OS v2 has no contract for this profile.");
    return;
  }
  const addMissing = (key: string, area: string, description: string) => {
    errors.push(description);
    missingCoverage.push({ key, area, description, severity: "high", requiredForCompletion: true });
  };
  const sourceFamilies = sourceFamiliesPresent(data.sources);
  for (const family of contract.requiredSourceFamilies) {
    if (!sourceFamilies.has(family)) {
      addMissing(`v2_source_${family}`, "source coverage", `Research OS v2 requires a ${family} source family for ${contract.profileKey}.`);
    }
  }
  if (data.unlinkedFactClaimCount > 0) {
    addMissing("v2_unlinked_facts", "evidence provenance", `${data.unlinkedFactClaimCount} factual claim(s) have no evidence link.`);
  }
  const completedModules = new Set(
    data.analysisSections.filter((section) => ["completed", "accepted"].includes(String(section.status))).map((section) => canonicalResearchKey(String(section.module_key)))
  );
  for (const moduleKey of contract.requiredModules) {
    if (!completedModules.has(moduleKey)) {
      addMissing(`v2_module_${moduleKey}`, "analysis coverage", `Required v2 module "${moduleKey}" is not completed.`);
    }
  }
  const metricKeys = new Set(data.metrics.filter((metric) => String(metric.review_status) === "accepted").map((metric) => canonicalResearchKey(String(metric.metric_key))));
  for (const metricKey of contract.requiredMetricKeys) {
    if (!metricKeys.has(metricKey)) {
      addMissing(`v2_metric_${metricKey}`, "metric coverage", `Required v2 metric "${metricKey}" is missing.`);
    }
  }
  const completedModels = new Set(
    data.valuationModels
      .filter((model) => String(model.status) === "completed" && Boolean(model.reproducible))
      .map((model) => String(model.model_key))
  );
  for (const modelKey of contract.valuationModelKeys) {
    if (!completedModels.has(modelKey)) {
      addMissing(`v2_model_${modelKey}`, "valuation artifact", `Required executable valuation model "${modelKey}" is missing or not reproducible.`);
    }
  }
  const modeledScenarios = data.scenarios.filter((scenario) => scenario.valuation_model_run_id);
  if (!modeledScenarios.some((scenario) => numericLike(scenario.value_anchor))) {
    addMissing("v2_modeled_scenarios", "valuation artifact", "No numeric scenario is linked to an executed valuation model.");
  }
  const usableIndicators = data.indicators.filter((indicator) => ["accepted", "completed"].includes(String(indicator.status)));
  if (usableIndicators.length < contract.minIndicators) {
    addMissing("v2_indicators", "indicator coverage", `Only ${usableIndicators.length}/${contract.minIndicators} validated indicators are available.`);
  }
  const executedCombinations = data.combinations.filter((combination) => String(combination.status) === "completed" && combination.backtest_run_id);
  if (executedCombinations.length < contract.minExecutedCombinations) {
    addMissing("v2_backtest_combinations", "backtest coverage", `Only ${executedCombinations.length}/${contract.minExecutedCombinations} strategy combinations were executed.`);
  }
  if (!data.backtestArtifacts.length) {
    addMissing("v2_backtest_artifacts", "backtest coverage", "No persisted backtest artifacts are available for this v2 run.");
  }
  const robustBacktests = data.backtests.filter((backtest) => {
    const metrics = typeof backtest.metrics_json === "string"
      ? (() => { try { return JSON.parse(backtest.metrics_json); } catch { return {}; } })()
      : backtest.metrics_json || {};
    return metrics.in_sample && metrics.out_of_sample && metrics.parameter_stability
      && Number.isFinite(Number(metrics.out_of_sample_excess_return));
  });
  if (executedCombinations.length && robustBacktests.length < executedCombinations.length) {
    addMissing(
      "v2_backtest_robustness",
      "backtest coverage",
      `Only ${robustBacktests.length}/${executedCombinations.length} completed combinations include in-sample, out-of-sample, benchmark-excess, and parameter-stability results.`
    );
  }
}

function isSubstantiveSource(source: Row) {
  const metadata = typeof source.metadata_json === "string"
    ? (() => { try { return JSON.parse(source.metadata_json); } catch { return {}; } })()
    : source.metadata_json || {};
  return metadata.collection_status !== "candidate_external_source" && metadata.fetch_status !== "failed";
}

function requiredAnalysisModules(profile: Row | undefined): unknown[] {
  const requiredModules = jsonArray(profile?.required_modules_json);
  const completionModules = jsonArray(((profile?.completion_criteria_json || {}) as Row).required_modules);
  return completionModules.length ? completionModules : requiredModules;
}

function analysisOutputs(data: Pick<RunQualityData, "run" | "artifacts" | "tasks">): Row[] {
  return (Number(data.run.pipeline_version || 1) >= 3
    ? (data.artifacts || []).filter((artifact) => ["validated", "accepted"].includes(artifact.status)).map((artifact): Row => ({ task_type: artifact.artifact_type, output_json: artifact.content_json, status: "completed" }))
    : data.tasks)
    .filter((task) => task.status === "completed");
}

/** Modules that no output name, evidence claim or metric covers. Only these need output bodies. */
function modulesUncoveredByName(
  data: Pick<RunQualityData, "evidence" | "metrics">,
  modules: unknown[],
  outputs: Row[]
): unknown[] {
  // One word set per claim and per metric: a module counts as covered only when a single claim or metric names
  // every word of its key ("net_debt" needs "net" and "debt", so "internet" or "net income" do not cover it).
  const texts = [
    ...data.evidence.map((claim) => claim.claim_text),
    ...data.metrics.map((metric) => [metric.metric_key, metric.display_name, metric.value_text].join(" ")),
  ].map(wordSet);
  return modules.filter((moduleKey) => {
    const normalized = String(moduleKey).toLowerCase();
    const tokens = [...wordSet(normalized)];
    return !outputs.some((task) => `${task.task_key ?? ""} ${task.task_type ?? ""}`.toLowerCase().includes(normalized))
      && !(tokens.length && texts.some((words) => tokens.every((token) => words.has(token))));
  });
}

function addAnalysisCoverage(
  data: RunQualityData,
  errors: string[],
  warnings: string[],
  missingCoverage: MissingCoverageItem[]
) {
  const modules = requiredAnalysisModules(data.profile);

  if (!modules.length) {
    warnings.push("Profile has no required analysis module list.");
    return;
  }

  const outputs = analysisOutputs(data);

  // Task and artifact names, evidence and metrics are checked first. Output bodies are then serialised one at a
  // time, and only while a module is still uncovered, so a run's artifacts are never held as one string.
  let uncovered = modulesUncoveredByName(data, modules, outputs);
  for (const task of outputs) {
    if (!uncovered.length) break;
    const text = `${stringifyBrief(task.output_json)} ${stringifyBrief(task.validation_result_json)}`.toLowerCase();
    uncovered = uncovered.filter((moduleKey) => !text.includes(String(moduleKey).toLowerCase()));
  }

  for (const moduleKey of uncovered) {
    const item: MissingCoverageItem = {
      key: `analysis_${moduleKey}`,
      severity: data.run.run_type === "quick_scan" ? "medium" : "high",
      area: "analysis coverage",
      description: `Required analysis module "${moduleKey}" has no substantive task, evidence, metric, or explicit source-gap coverage.`,
      requiredForCompletion: data.run.run_type !== "quick_scan",
    };
    missingCoverage.push(item);
    errors.push(item.description);
  }
}

function addValuationCoverage(
  data: RunQualityData,
  threshold: RunTypeThreshold,
  scenariosWithValueAnchors: number,
  errors: string[],
  warnings: string[],
  missingCoverage: MissingCoverageItem[]
) {
  const requiredLenses = jsonArray(data.profile?.required_valuation_lenses_json);
  const coveredLenses = new Set(data.signals.map((signal) => signal.lens_family));
  const valuationWithheldReason = valuationWithheld(data.artifacts);

  for (const lens of requiredLenses) {
    if (!coveredLenses.has(lens)) {
      const item: MissingCoverageItem = {
        key: `valuation_lens_${lens}`,
        severity: "high",
        area: "valuation depth",
        description: `Required valuation lens "${lens}" has no valuation signal.`,
        requiredForCompletion: data.run.run_type !== "quick_scan",
      };
      missingCoverage.push(item);
      errors.push(item.description);
    }
  }

  const notApplicableWithoutReason = data.signals.filter(
    (signal) =>
      signal.signal === "not_applicable" &&
      !signal.current_value_text &&
      !stringifyBrief(signal.metadata_json).toLowerCase().includes("reason")
  );
  if (notApplicableWithoutReason.length > 0) {
    warnings.push(
      `${notApplicableWithoutReason.length} not-applicable valuation signal(s) lack an explicit reason.`
    );
  }

  if (threshold.requireValueAnchors && scenariosWithValueAnchors === 0) {
    const hasBlockingSourceGap = data.sourceGaps.some(
      (gap) => isOpenGap(gap) && ["high", "critical"].includes(String(gap.severity))
    );
    const item: MissingCoverageItem = {
      key: valuationWithheldReason ? VALUATION_WITHHELD_KEY : "scenario_value_anchors",
      severity: "high",
      area: "valuation depth",
      description: valuationWithheldReason
        ? `Valuation withheld; no scenario value anchors exist and the run is not action-ready: ${valuationWithheldReason}`
        : hasBlockingSourceGap
        ? "No numeric scenario value anchors are present; high-severity source gaps explain the blocker but the run is not action-ready."
        : "No numeric scenario value anchors are present.",
      requiredForCompletion: true,
    };
    missingCoverage.push(item);
    errors.push(item.description);
  }

  const scenarioTypes = new Set(data.scenarios.map((scenario) => String(scenario.scenario_type).toLowerCase()));
  if (data.run.run_type !== "quick_scan" && data.scenarios.length > 0) {
    for (const scenarioType of ["bear", "base", "bull"]) {
      if (!scenarioTypes.has(scenarioType)) {
        warnings.push(`Scenario set is missing a ${scenarioType} case.`);
      }
    }
  }
}

function addAiReviewCoverage(
  data: RunQualityData,
  errors: string[],
  warnings: string[],
  missingCoverage: MissingCoverageItem[]
) {
  const reviewTask = data.tasks.find(
    (task) => task.task_type === "ai_review" && task.status === "completed"
  );

  if (!reviewTask) {
    if (data.run.run_type !== "quick_scan") {
      errors.push("Latest AI review task is missing.");
      missingCoverage.push({
        key: "ai_review_missing",
        severity: "high",
        area: "AI review",
        description: "Latest AI review task is missing.",
        requiredForCompletion: true,
      });
    }
    return;
  }

  const passFail = reviewVerdict(reviewTask.output_json);

  if (!passFail) {
    const description = "AI review output has no parsed verdict.";
    errors.push(description);
    missingCoverage.push({
      key: "ai_review_outcome",
      severity: "high",
      area: "AI review",
      description,
      requiredForCompletion: true,
    });
    return;
  }

  if (passFail === "conditional_pass") {
    warnings.push("AI review outcome is conditional_pass.");
  }

  // Fail closed: anything other than an explicit pass or conditional_pass blocks.
  if (!PASSING_REVIEW_VERDICTS.has(passFail)) {
    const description = `AI review outcome is ${passFail}.`;
    errors.push(description);
    missingCoverage.push({
      key: "ai_review_outcome",
      severity: passFail === "needs_more_work" ? "high" : "critical",
      area: "AI review",
      description,
      requiredForCompletion: true,
    });
  }
}

function addHumanReviewCoverage(
  data: RunQualityData,
  threshold: RunTypeThreshold,
  errors: string[],
  warnings: string[],
  missingCoverage: MissingCoverageItem[]
) {
  if (!threshold.requireHumanReview) return;

  const latestDecision = data.reviewDecisions[0];
  if (!latestDecision) {
    errors.push("Human review decision is required before completion.");
    missingCoverage.push({
      key: "human_review_decision",
      severity: "high",
      area: "human review",
      description: "Human review decision is required before completion.",
      requiredForCompletion: true,
    });
    return;
  }

  const status = String(latestDecision.status || "").toLowerCase();
  if (!KNOWN_REVIEW_STATUSES.has(status)) {
    const description = `Human review decision has unknown status: ${status || "empty"}.`;
    errors.push(description);
    missingCoverage.push({
      key: "human_review_status_invalid",
      severity: "high",
      area: "human review",
      description,
      requiredForCompletion: true,
    });
  } else if (REJECTING_REVIEW_STATUSES.has(status)) {
    errors.push(`Human review decision is ${status}.`);
  } else if (status === "approved_for_tracking" || status === "watchlist") {
    warnings.push("Human review permits tracking/watchlist use only; this is not position-ready.");
  }
}

function actionReadinessFor(
  data: RunQualityData,
  threshold: RunTypeThreshold,
  status: ResearchQualityGateResult["status"]
): ResearchQualityGateResult["actionReadiness"] {
  if (data.run.run_type === "quick_scan") return "triage_only";
  if (status !== "pass") return "research_scaffold";
  if (threshold.requireHumanReview && data.reviewDecisions.length === 0) return "review_ready";

  const decision = String(data.reviewDecisions[0]?.status || "").toLowerCase();
  const baseReadiness = (decision === "approved_for_tracking" || decision === "watchlist") ? "review_ready" : "investment_ready";
  const reviewTask = data.tasks.find((task) => task.task_type === "ai_review" && task.status === "completed");
  if (reviewVerdict(reviewTask?.output_json) === "conditional_pass" && baseReadiness === "investment_ready") return "review_ready";

  const metadata = typeof data.run.metadata_json === "string"
    ? JSON.parse(data.run.metadata_json)
    : data.run.metadata_json || {};
  const isSynthetic = metadata.acceptance_provider === "mock" || process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock";

  if (isSynthetic && baseReadiness === "investment_ready") {
    return "review_ready";
  }

  return baseReadiness;
}

function thresholdFor(runType: string): RunTypeThreshold {
  return RUN_TYPE_THRESHOLDS[runType] || RUN_TYPE_THRESHOLDS.deep_dive;
}

function hasSource(sources: Row[], keywords: string[]) {
  return sources.some((source) => {
    const text = `${source.source_type || ""} ${source.title || ""} ${source.publisher || ""} ${source.url || ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });
}

function numericLike(value: unknown) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function wordSet(text: unknown): Set<string> {
  return new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringifyBrief(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeReviewOutput(output: unknown): Row {
  if (!output) return {};
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof output === "object" ? output as Row : {};
}

const PASSING_REVIEW_VERDICTS = new Set(["pass", "conditional_pass"]);

/**
 * The AI review verdict, trimmed and lower-cased. review_verdict is canonical (the v3 contract); pass_fail is read
 * only when it is absent, for reviews from earlier pipelines. Other fields such as status are never read, so a stray
 * value cannot mask the verdict. Returns "" when there is none.
 */
export function reviewVerdict(output: unknown): string {
  const review = normalizeReviewOutput(output);
  const verdict = review.review_verdict !== undefined ? review.review_verdict : review.pass_fail;
  return typeof verdict === "string" ? verdict.trim().toLowerCase() : "";
}

function isOpenGap(gap: Row) {
  return !["closed", "resolved", "accepted"].includes(String(gap.status || "open").toLowerCase());
}

function normalizeSeverity(value: unknown): MissingCoverageItem["severity"] {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
}

/**
 * Convenience wrapper for evaluateLoadedResearchQuality that accepts a
 * partial data shape and fills sensible defaults for missing fields.
 * Used by test harnesses that pre-load only the data they need.
 */
export function evaluateQualityGates(data: Partial<RunQualityData> & Record<string, unknown>): ResearchQualityGateResult {
  return evaluateLoadedResearchQuality({
    run: (data.run ?? {}) as Row,
    stages: (data.stages ?? []) as Row[],
    tasks: (data.tasks ?? []) as Row[],
    sources: (data.sources ?? []) as Row[],
    evidence: (data.evidence ?? []) as Row[],
    metrics: (data.metrics ?? []) as Row[],
    signals: (data.signals ?? []) as Row[],
    scenarios: (data.scenarios ?? []) as Row[],
    sourceGaps: (data.sourceGaps ?? []) as Row[],
    reviewDecisions: (data.reviewDecisions ?? []) as Row[],
    analysisSections: (data.analysisSections ?? []) as Row[],
    artifacts: (data.artifacts ?? []) as Row[],
    valuationModels: (data.valuationModels ?? []) as Row[],
    indicators: (data.indicators ?? []) as Row[],
    combinations: (data.combinations ?? []) as Row[],
    backtests: (data.backtests ?? []) as Row[],
    backtestArtifacts: (data.backtestArtifacts ?? []) as Row[],
    unlinkedFactClaimCount: (data.unlinkedFactClaimCount ?? 0) as number,
    ...(data.asset ? { asset: data.asset as Row } : {}),
    ...(data.profile ? { profile: data.profile as Row } : {}),
  });
}
