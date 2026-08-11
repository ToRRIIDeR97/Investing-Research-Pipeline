// ============================================================
// Stage definitions — deterministic FSM for research runs.
// Each stage has entry criteria, completion criteria, and
// validation rules. This is application logic, not an AI agent.
// ============================================================

export interface StageConfig {
  key: string;
  order: number;
  name: string;
  description: string;
  allowedModelTiers: string[];
  maxRetries: number;
  maxBudgetUsd: number | null;
  requiresHumanApproval: boolean;
  requiredOutputs: string[];
  entryCriteria: string[];
  validationRules: string[];
  failureState: "fail_run" | "skip_and_continue" | "pause_for_human";
  skippable: boolean;
  skipForRunTypes: string[];
  skipReason?: string;
}

export const STAGE_CONFIGS: StageConfig[] = [
  {
    key: "intake",
    order: 1,
    name: "Intake",
    description: "Parse the research question, identify the asset, and validate that a run can proceed.",
    allowedModelTiers: ["cheap"],
    maxRetries: 2,
    maxBudgetUsd: 0.50,
    requiresHumanApproval: false,
    requiredOutputs: [],
    entryCriteria: [],
    validationRules: [],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "asset_identity",
    order: 2,
    name: "Asset Identity",
    description: "Assign or confirm the asset profile and resolve instruments, listings, and legal entities.",
    allowedModelTiers: ["cheap", "mid"],
    maxRetries: 2,
    maxBudgetUsd: 1.00,
    requiresHumanApproval: false,
    requiredOutputs: ["profile_assignment"],
    entryCriteria: ["run_status_is_running"],
    validationRules: [],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "archetype_composition",
    order: 3,
    name: "Archetype Composition",
    description: "Compose business archetypes to determine required sources, metrics, and analysis.",
    allowedModelTiers: ["cheap", "mid"],
    maxRetries: 2,
    maxBudgetUsd: 1.00,
    requiresHumanApproval: false,
    requiredOutputs: ["profile_assignment"],
    entryCriteria: ["asset_identity_completed"],
    validationRules: [],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "research_plan",
    order: 4,
    name: "Research Plan",
    description: "Generate the structured research plan outlining scope, modules, and source strategy. Requires human approval.",
    allowedModelTiers: ["mid", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 2.00,
    requiresHumanApproval: true,
    requiredOutputs: ["research_plan_json"],
    entryCriteria: ["profile_assigned"],
    validationRules: [],
    failureState: "pause_for_human",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "source_discovery",
    order: 5,
    name: "Source Discovery",
    description: "Identify, rank, and catalog candidate sources. Record source gaps.",
    allowedModelTiers: ["cheap", "mid"],
    maxRetries: 3,
    maxBudgetUsd: 3.00,
    requiresHumanApproval: false,
    requiredOutputs: ["source_inventory", "source_gaps"],
    entryCriteria: ["research_plan_approved"],
    validationRules: ["source_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "source_ingestion",
    order: 6,
    name: "Source Ingestion",
    description: "Download, parse, chunk, and index source documents.",
    allowedModelTiers: ["cheap"],
    maxRetries: 3,
    maxBudgetUsd: 2.00,
    requiresHumanApproval: false,
    requiredOutputs: ["parsed_documents"],
    entryCriteria: ["source_inventory_exists"],
    validationRules: [],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "evidence_extraction",
    order: 7,
    name: "Evidence Extraction",
    description: "Extract structured evidence claims from parsed documents with source links.",
    allowedModelTiers: ["cheap", "mid"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["evidence_claims"],
    entryCriteria: ["parsed_documents_exist"],
    validationRules: ["source_link_validation"],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "historical_record",
    order: 8,
    name: "Historical Record",
    description: "Build normalized twenty-quarter historical record.",
    allowedModelTiers: ["cheap", "mid"],
    maxRetries: 2,
    maxBudgetUsd: 3.00,
    requiresHumanApproval: false,
    requiredOutputs: ["metric_observations"],
    entryCriteria: ["evidence_claims_exist"],
    validationRules: ["point_in_time_validation"],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "company_genesis",
    order: 9,
    name: "Company Genesis",
    description: "Synthesize strategic identity, origin history, and founder profile.",
    allowedModelTiers: ["mid", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 3.00,
    requiresHumanApproval: false,
    requiredOutputs: ["genesis_artifacts"],
    entryCriteria: ["evidence_claims_exist"],
    validationRules: ["genesis_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "historical_diagnosis",
    order: 10,
    name: "Historical Diagnosis",
    description: "Diagnose level-shifts and inflections in the historical record.",
    allowedModelTiers: ["mid", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 3.00,
    requiresHumanApproval: false,
    requiredOutputs: ["historical_diagnosis"],
    entryCriteria: ["metric_observations_exist"],
    validationRules: ["diagnosis_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "business_process_analysis",
    order: 11,
    name: "Business Process Analysis",
    description: "Model customer decisions, segment models, and business process maps.",
    allowedModelTiers: ["mid", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["business_process_map"],
    entryCriteria: ["genesis_artifacts_exist"],
    validationRules: ["business_process_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "moat_analysis",
    order: 12,
    name: "Moat Analysis",
    description: "Assess moat strength, durability, and model attack scenarios.",
    allowedModelTiers: ["mid", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["moat_assessment"],
    entryCriteria: ["business_process_map_exists"],
    validationRules: ["moat_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "operating_model",
    order: 13,
    name: "Operating Model",
    description: "Build forecast driver tree and detailed operating model.",
    allowedModelTiers: ["mid", "premium", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["operating_model"],
    entryCriteria: ["moat_assessment_exists", "historical_diagnosis_exists"],
    validationRules: ["operating_model_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "operating_scenarios",
    order: 14,
    name: "Operating Scenarios",
    description: "Synthesize bear, base, and bull operating forecasts.",
    allowedModelTiers: ["premium", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["operating_scenario_set"],
    entryCriteria: ["operating_model_exists"],
    validationRules: ["operating_scenario_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "asset_valuation",
    order: 15,
    name: "Asset Valuation",
    description: "Run valuation models and price-target paths for all scenarios.",
    allowedModelTiers: ["mid", "premium", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 10.00,
    requiresHumanApproval: false,
    requiredOutputs: ["valuation_signals", "scenarios"],
    entryCriteria: ["operating_scenario_set_exists"],
    validationRules: ["asset_profile_validation", "valuation_depth_validation", "valuation_path_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "indicator_design",
    order: 16,
    name: "Indicator Design",
    description: "Define at least ten thesis-driven, source-classified indicators with explicit lookahead controls.",
    allowedModelTiers: [],
    maxRetries: 1,
    maxBudgetUsd: null,
    requiresHumanApproval: false,
    requiredOutputs: ["indicator_catalog"],
    entryCriteria: ["valuation_signals_exist"],
    validationRules: [],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["quick_scan"],
  },
  {
    key: "strategy_design",
    order: 17,
    name: "Strategy Design",
    description: "Generate fifty thesis-distinct combinations across five research buckets; parameter sweeps do not count.",
    allowedModelTiers: [],
    maxRetries: 1,
    maxBudgetUsd: null,
    requiresHumanApproval: false,
    requiredOutputs: ["strategy_combination_catalog"],
    entryCriteria: ["indicator_catalog_exists"],
    validationRules: [],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["quick_scan"],
  },
  {
    key: "backtest_execution",
    order: 18,
    name: "Backtest Execution",
    description: "Execute all combinations with shifted signals, transaction costs, benchmarks, and chronological in/out-of-sample results.",
    allowedModelTiers: [],
    maxRetries: 1,
    maxBudgetUsd: null,
    requiresHumanApproval: false,
    requiredOutputs: ["backtest_execution_summary"],
    entryCriteria: ["strategy_combination_catalog_exists"],
    validationRules: [],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["quick_scan"],
  },
  {
    key: "backtest_review",
    order: 19,
    name: "Backtest Review",
    description: "Rank all combinations, review the top ten and at least five failures, and enforce the conclusion gate.",
    allowedModelTiers: [],
    maxRetries: 1,
    maxBudgetUsd: null,
    requiresHumanApproval: false,
    requiredOutputs: ["backtest_review"],
    entryCriteria: ["backtest_execution_completed"],
    validationRules: [],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["quick_scan"],
  },
  {
    key: "decision_synthesis",
    order: 20,
    name: "Decision Synthesis",
    description: "Synthesize thesis, risks, catalysts, Expected Return, monitoring thresholds, and the reviewed backtest evidence.",
    allowedModelTiers: ["mid", "premium", "specialist"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["thesis", "risks", "catalysts"],
    entryCriteria: ["asset_valuation_completed"],
    validationRules: ["decision_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "ai_reviewer",
    order: 21,
    name: "AI Reviewer",
    description: "Automated review pass checking consistency across all current artifacts, including backtest evidence and limitations.",
    allowedModelTiers: ["premium"],
    maxRetries: 1,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["review_findings"],
    entryCriteria: ["decision_synthesis_completed"],
    validationRules: ["review_outcome_validation"],
    failureState: "fail_run",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "human_review",
    order: 22,
    name: "Human Review",
    description: "Pause for human investment committee decision.",
    allowedModelTiers: [],
    maxRetries: 0,
    maxBudgetUsd: null,
    requiresHumanApproval: true,
    requiredOutputs: [],
    entryCriteria: ["ai_reviewer_completed"],
    validationRules: ["human_review_validation"],
    failureState: "pause_for_human",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "export",
    order: 23,
    name: "Export",
    description: "Generate final initiation package.",
    allowedModelTiers: ["mid"],
    maxRetries: 2,
    maxBudgetUsd: 2.00,
    requiresHumanApproval: false,
    requiredOutputs: ["export_artifact"],
    entryCriteria: ["human_review_completed"],
    validationRules: [],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
  {
    key: "refresh_schedule",
    order: 24,
    name: "Refresh Schedule",
    description: "Cadence setup.",
    allowedModelTiers: ["cheap"],
    maxRetries: 1,
    maxBudgetUsd: 0.10,
    requiresHumanApproval: false,
    requiredOutputs: [],
    entryCriteria: ["export_completed"],
    validationRules: [],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
  },
];

/** Map from stage key to config for O(1) lookups. */
export const STAGE_CONFIG_MAP: Record<string, StageConfig> = Object.fromEntries(
  STAGE_CONFIGS.map((s) => [s.key, s])
);

export function getStageConfig(key: string): StageConfig | undefined {
  return STAGE_CONFIG_MAP[key];
}

const OPTIONAL_BACKTEST_STAGES = new Set(["indicator_design", "strategy_design", "backtest_execution", "backtest_review"]);

export function shouldSkipOptionalBacktest(stageKey: string, backtestRequired: boolean): boolean {
  return !backtestRequired && OPTIONAL_BACKTEST_STAGES.has(stageKey);
}

/**
 * Return all stages for a run type, including those that should be skipped.
 * §25.2: Skipped stages must be explicitly marked skipped with a reason.
 */
export function getAllStagesForRun(runType: string): {
  applicable: StageConfig[];
  skipped: StageConfig[];
} {
  const applicable: StageConfig[] = [];
  const skipped: StageConfig[] = [];

  for (const stage of STAGE_CONFIGS) {
    if (stage.skippable && stage.skipForRunTypes.includes(runType)) {
      skipped.push(stage);
    } else {
      applicable.push(stage);
    }
  }

  return { applicable, skipped };
}

/**
 * Return only applicable (non-skipped) stages for a run type.
 */
export function getApplicableStages(runType: string): StageConfig[] {
  return STAGE_CONFIGS.filter(
    (stage) => !(stage.skippable && stage.skipForRunTypes.includes(runType))
  );
}
