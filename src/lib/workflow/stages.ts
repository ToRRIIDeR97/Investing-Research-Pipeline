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
    skipReason: "Backtest-only runs skip intake — asset is already known",
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
    skipReason: "Backtest-only runs skip asset identity — the asset is already selected",
  },
  {
    key: "research_plan",
    order: 3,
    name: "Research Plan",
    description: "Generate the structured research plan outlining scope, modules, and source strategy. Requires human approval before proceeding.",
    allowedModelTiers: ["mid"],
    maxRetries: 2,
    maxBudgetUsd: 2.00,
    requiresHumanApproval: true,
    requiredOutputs: ["research_plan_json"],
    entryCriteria: ["profile_assigned"],
    validationRules: [],
    failureState: "pause_for_human",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
    skipReason: "Backtest-only runs skip research planning",
  },
  {
    key: "source_discovery",
    order: 4,
    name: "Source Discovery",
    description: "Identify, rank, and catalog candidate sources. Record source gaps that cannot be filled.",
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
    skipReason: "Backtest-only runs skip source discovery",
  },
  {
    key: "source_ingestion",
    order: 5,
    name: "Source Ingestion",
    description: "Download, parse, chunk, and index source documents for downstream extraction.",
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
    skipReason: "Backtest-only runs skip source ingestion",
  },
  {
    key: "evidence_extraction",
    order: 6,
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
    skipReason: "Backtest-only runs skip evidence extraction",
  },
  {
    key: "metric_normalization",
    order: 7,
    name: "Metric Normalization",
    description: "Normalize extracted data into canonical metric observations with units, currencies, and periods aligned.",
    allowedModelTiers: ["cheap", "mid"],
    maxRetries: 2,
    maxBudgetUsd: 3.00,
    requiresHumanApproval: false,
    requiredOutputs: ["metric_observations"],
    entryCriteria: ["evidence_claims_exist"],
    validationRules: ["point_in_time_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
    skipReason: "Backtest-only runs skip metric normalization",
  },
  {
    key: "asset_analysis",
    order: 8,
    name: "Asset Analysis",
    description: "Synthesize evidence and metrics into structured analysis sections (business quality, financials, competitive position).",
    allowedModelTiers: ["mid", "premium"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["analysis_sections"],
    entryCriteria: ["evidence_claims_exist", "metric_observations_exist"],
    validationRules: [],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
    skipReason: "Backtest-only runs skip asset analysis",
  },
  {
    key: "asset_valuation",
    order: 9,
    name: "Asset Valuation",
    description: "Run profile-appropriate valuation methods, generate valuation signals, and build scenarios.",
    allowedModelTiers: ["mid", "premium"],
    maxRetries: 2,
    maxBudgetUsd: 10.00,
    requiresHumanApproval: false,
    requiredOutputs: ["valuation_signals", "scenarios"],
    entryCriteria: ["metric_observations_exist"],
    validationRules: ["asset_profile_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
    skipReason: "Backtest-only runs skip asset valuation",
  },
  {
    key: "thesis_risks",
    order: 10,
    name: "Thesis & Risks",
    description: "Formulate the investment thesis, enumerate risks with mitigants, and identify catalysts.",
    allowedModelTiers: ["mid", "premium"],
    maxRetries: 2,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["thesis", "risks", "catalysts"],
    entryCriteria: ["valuation_signals_exist"],
    validationRules: [],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
    skipReason: "Backtest-only runs skip thesis and risk synthesis",
  },
  {
    key: "indicator_design",
    order: 11,
    name: "Indicator Design",
    description: "Design leading and lagging indicators tied to thesis drivers and risk factors.",
    allowedModelTiers: ["mid"],
    maxRetries: 2,
    maxBudgetUsd: 3.00,
    requiresHumanApproval: false,
    requiredOutputs: [],
    entryCriteria: ["thesis_exists"],
    validationRules: [],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["quick_scan", "backtest_only"],
    skipReason: "This run type does not require indicator design",
  },
  {
    key: "backtest_execution",
    order: 12,
    name: "Backtest Execution",
    description: "Run historical backtests on indicators and signals using market data.",
    allowedModelTiers: ["premium"],
    maxRetries: 2,
    maxBudgetUsd: 10.00,
    requiresHumanApproval: false,
    requiredOutputs: ["backtest_results"],
    entryCriteria: ["indicator_definitions_exist"],
    validationRules: ["point_in_time_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["quick_scan", "thesis_investigation"],
    skipReason: "Quick scans and thesis investigations do not require backtests",
  },
  {
    key: "ai_reviewer",
    order: 13,
    name: "AI Reviewer",
    description: "Automated review pass that checks for internal consistency, unsupported claims, and missing coverage.",
    allowedModelTiers: ["premium"],
    maxRetries: 1,
    maxBudgetUsd: 5.00,
    requiresHumanApproval: false,
    requiredOutputs: ["review_findings"],
    entryCriteria: ["thesis_exists"],
    validationRules: ["source_link_validation", "asset_profile_validation"],
    failureState: "skip_and_continue",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
    skipReason: "Backtest-only runs skip AI review",
  },
  {
    key: "human_review",
    order: 14,
    name: "Human Review",
    description: "Pause for human analyst review. Conviction, priority, and open questions are recorded as structured data.",
    allowedModelTiers: [],
    maxRetries: 0,
    maxBudgetUsd: null,
    requiresHumanApproval: true,
    requiredOutputs: [],
    entryCriteria: ["ai_reviewer_completed"],
    validationRules: [],
    failureState: "pause_for_human",
    skippable: true,
    skipForRunTypes: ["backtest_only"],
    skipReason: "Backtest-only runs skip human research review",
  },
  {
    key: "export",
    order: 15,
    name: "Export",
    description: "Generate the final research artifact (markdown, PDF, CSV) and store it.",
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
    skipReason: "Backtest-only runs skip export generation",
  },
  {
    key: "refresh_schedule",
    order: 16,
    name: "Refresh Schedule",
    description: "Set up the refresh cadence for the research run so it can be periodically re-executed.",
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
    skipReason: "Backtest-only runs skip refresh scheduling",
  },
];

/** Map from stage key to config for O(1) lookups. */
export const STAGE_CONFIG_MAP: Record<string, StageConfig> = Object.fromEntries(
  STAGE_CONFIGS.map((s) => [s.key, s])
);

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
 * Kept for backward compatibility.
 */
export function getApplicableStages(runType: string): StageConfig[] {
  return STAGE_CONFIGS.filter(
    (stage) => !(stage.skippable && stage.skipForRunTypes.includes(runType))
  );
}
