export const RESEARCH_AGENT_NAMES = [
  "intake-planner",
  "asset-classifier",
  "source-discovery-agent",
  "source-reader",
  "table-normalizer",
  "metric-normalizer",
  "asset-analyst",
  "valuation-analyst",
  "valuation-coder",
  "backtest-coder",
  "research-reviewer",
  "export-writer",
  "document-vision-agent",
  "chart-interpreter-agent",
  "table-vision-agent",
  "visual-evidence-agent",
  "ui-output-qa-vision-agent",
] as const;

export type ResearchAgentName = (typeof RESEARCH_AGENT_NAMES)[number];

export type AgentRoute =
  | "cheap"
  | "mid"
  | "vision"
  | "asset-analyst"
  | "valuation-analyst"
  | "research-reviewer"
  | "valuation-coder"
  | "backtest-coder";

export interface ResearchAgentConfig {
  name: ResearchAgentName;
  description: string;
  route: AgentRoute;
  modelTier: "cheap" | "mid" | "premium" | "vision" | "specialist";
  defaultModel: string;
  modelEnvVar: string;
  promptVersion: string;
  tools: Record<string, boolean>;
  outputSchemaKey: string;
  outputSchemaVersion: number;
  outputFormat: Record<string, unknown>;
}

const objectValue = {
  type: "object",
  additionalProperties: true,
};

const stringArray = {
  type: "array",
  items: { type: "string" },
};

const objectArray = {
  type: "array",
  items: objectValue,
};

const nullableString = {
  type: ["string", "null"],
};

const evidenceClaimArray = {
  type: "array",
  minItems: 5,
  items: {
    type: "object",
    additionalProperties: true,
    required: ["claim_text", "claim_type", "claim_category", "confidence"],
    properties: {
      claim_text: { type: "string", minLength: 20 },
      claim_type: { type: "string", minLength: 2 },
      claim_category: { type: "string", enum: ["fact", "estimate", "assumption", "opinion"] },
      as_of_date: nullableString,
      period_end: nullableString,
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

function schema(required: string[], properties: Record<string, any>): Record<string, any> {
  return {
    type: "json_schema",
    retryCount: 2,
    schema: {
      type: "object",
      additionalProperties: true,
      required,
      properties,
    },
  };
}

export function normalizeModelEnvValue(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return trimmed;

  const withoutProvider = trimmed.includes("/")
    ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
    : trimmed;
  const compact = withoutProvider.toLowerCase().replace(/[^a-z0-9]/g, "");

  const aliases: Record<string, string> = {
    deepseekv4flash: "deepseek-v4-flash",
    deepseekv4pro: "deepseek-v4-pro",
    qwen37plus: "qwen3.7-plus",
    qwen3v7plus: "qwen3.7-plus",
    qwen37max: "qwen3.7-max",
    glm52: "glm-5.2",
    kimi27code: "kimi-k2.7-code",
    kimik27code: "kimi-k2.7-code",
    kimik2p7code: "kimi-k2.7-code",
    kimik2dot7code: "kimi-k2.7-code",
  };

  return aliases[compact] || withoutProvider;
}

const backtestCodegenOutputFormat = schema(
  ["strategy_name", "strategy_description", "files", "run_instructions", "assumptions"],
  {
    strategy_name: { type: "string" },
    strategy_description: { type: "string" },
    run_instructions: { type: "string" },
    assumptions: stringArray,
    files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: {
            type: "string",
            description: "Relative file path. The main strategy file must be strategy.py.",
          },
          content: { type: "string" },
          purpose: { type: "string" },
        },
      },
    },
  }
);

export const AGENT_CONFIGS: Record<ResearchAgentName, ResearchAgentConfig> = {
  "intake-planner": {
    name: "intake-planner",
    description: "Convert a user research request into a bounded research run plan.",
    route: "mid",
    modelTier: "mid",
    defaultModel: "deepseek-v4-pro",
    modelEnvVar: "RESEARCH_MID_MODEL",
    promptVersion: "intake-planner-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "research_plan",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "objective",
        "asset_hypothesis",
        "run_type",
        "required_modules",
        "source_strategy",
        "planned_agent_tasks",
        "approval_questions",
        "source_gaps",
        "risk_flags",
        "confidence",
      ],
      {
        objective: { type: "string" },
        asset_hypothesis: objectValue,
        run_type: {
          type: "string",
          enum: ["full_research", "quick_scan", "thesis_investigation", "backtest_only", "refresh"],
        },
        required_modules: stringArray,
        source_strategy: objectArray,
        planned_agent_tasks: objectArray,
        approval_questions: stringArray,
        source_gaps: objectArray,
        risk_flags: objectArray,
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }
    ),
  },
  "asset-classifier": {
    name: "asset-classifier",
    description: "Select or challenge the asset research profile.",
    route: "cheap",
    modelTier: "cheap",
    defaultModel: "deepseek-v4-flash",
    modelEnvVar: "RESEARCH_CHEAP_MODEL",
    promptVersion: "asset-classifier-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "profile_assignment",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "selected_profile_key",
        "selected_profile_name",
        "confidence",
        "asset_kind",
        "identity_resolution",
        "required_modules",
        "rejected_profiles",
        "classification_evidence",
        "ambiguities",
        "recommended_next_tasks",
      ],
      {
        selected_profile_key: { type: "string" },
        selected_profile_name: nullableString,
        confidence: { type: "number", minimum: 0, maximum: 1 },
        asset_kind: { type: "string" },
        identity_resolution: objectValue,
        required_modules: stringArray,
        rejected_profiles: objectArray,
        classification_evidence: objectArray,
        ambiguities: objectArray,
        recommended_next_tasks: objectArray,
      }
    ),
  },
  "source-discovery-agent": {
    name: "source-discovery-agent",
    description: "Identify and rank source candidates.",
    route: "cheap",
    modelTier: "cheap",
    defaultModel: "deepseek-v4-flash",
    modelEnvVar: "RESEARCH_CHEAP_MODEL",
    promptVersion: "source-discovery-agent-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "source_inventory",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "source_candidates",
        "required_primary_sources",
        "secondary_sources",
        "source_gaps",
        "freshness_constraints",
        "risk_flags",
        "recommended_ingestion_tasks",
      ],
      {
        source_candidates: objectArray,
        required_primary_sources: objectArray,
        secondary_sources: objectArray,
        source_gaps: objectArray,
        freshness_constraints: objectArray,
        risk_flags: objectArray,
        recommended_ingestion_tasks: objectArray,
      }
    ),
  },
  "source-reader": {
    name: "source-reader",
    description: "Extract source-linked evidence claims from parsed chunks.",
    route: "cheap",
    modelTier: "cheap",
    defaultModel: "deepseek-v4-flash",
    modelEnvVar: "RESEARCH_CHEAP_MODEL",
    promptVersion: "source-reader-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "evidence_claim_batch",
    outputSchemaVersion: 1,
    outputFormat: schema(
      ["evidence_claims", "contradictions", "source_gaps", "low_confidence_items", "rejected_candidates"],
      {
        evidence_claims: evidenceClaimArray,
        contradictions: objectArray,
        source_gaps: objectArray,
        low_confidence_items: objectArray,
        rejected_candidates: objectArray,
      }
    ),
  },
  "table-normalizer": {
    name: "table-normalizer",
    description: "Convert extracted tables into normalized metric candidates.",
    route: "mid",
    modelTier: "mid",
    defaultModel: "deepseek-v4-pro",
    modelEnvVar: "RESEARCH_MID_MODEL",
    promptVersion: "table-normalizer-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "metric_observation_batch",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "metric_observations",
        "table_mapping",
        "unmapped_cells",
        "normalization_warnings",
        "requires_vision_escalation",
        "source_gaps",
      ],
      {
        metric_observations: objectArray,
        table_mapping: objectValue,
        unmapped_cells: objectArray,
        normalization_warnings: objectArray,
        requires_vision_escalation: objectValue,
        source_gaps: objectArray,
      }
    ),
  },
  "metric-normalizer": {
    name: "metric-normalizer",
    description: "Standardize metric observations.",
    route: "cheap",
    modelTier: "cheap",
    defaultModel: "deepseek-v4-flash",
    modelEnvVar: "RESEARCH_CHEAP_MODEL",
    promptVersion: "metric-normalizer-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "normalized_metric_batch",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "normalized_observations",
        "definition_mappings",
        "conversion_notes",
        "unresolved_ambiguities",
        "quality_flags",
        "source_gaps",
      ],
      {
        normalized_observations: objectArray,
        definition_mappings: objectArray,
        conversion_notes: objectArray,
        unresolved_ambiguities: objectArray,
        quality_flags: objectArray,
        source_gaps: objectArray,
      }
    ),
  },
  "asset-analyst": {
    name: "asset-analyst",
    description: "Synthesize accepted evidence into asset-specific analysis sections.",
    route: "asset-analyst",
    modelTier: "specialist",
    defaultModel: "deepseek-v4-pro",
    modelEnvVar: "RESEARCH_ASSET_ANALYST_MODEL",
    promptVersion: "asset-analyst-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "analysis_sections",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "analysis_sections",
        "key_drivers",
        "metric_interpretation",
        "contradictions_or_tensions",
        "missing_modules",
        "source_gaps",
        "analyst_questions",
        "confidence",
      ],
      {
        analysis_sections: objectArray,
        key_drivers: objectArray,
        metric_interpretation: objectArray,
        contradictions_or_tensions: objectArray,
        missing_modules: objectArray,
        source_gaps: objectArray,
        analyst_questions: stringArray,
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }
    ),
  },
  "valuation-analyst": {
    name: "valuation-analyst",
    description: "Produce valuation signals and scenarios.",
    route: "valuation-analyst",
    modelTier: "premium",
    defaultModel: "kimi-k2.7-code",
    modelEnvVar: "RESEARCH_VALUATION_ANALYST_MODEL",
    promptVersion: "valuation-analyst-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "valuation_signal_batch",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "applicable_methods",
        "not_applicable_methods",
        "valuation_signals",
        "scenarios",
        "assumptions",
        "sensitivity_notes",
        "method_risks",
        "source_gaps",
      ],
      {
        applicable_methods: objectArray,
        not_applicable_methods: objectArray,
        valuation_signals: objectArray,
        scenarios: objectArray,
        assumptions: objectArray,
        sensitivity_notes: objectArray,
        method_risks: objectArray,
        source_gaps: objectArray,
      }
    ),
  },
  "valuation-coder": {
    name: "valuation-coder",
    description: "Generate bounded valuation model code artifacts.",
    route: "valuation-coder",
    modelTier: "premium",
    defaultModel: "kimi-k2.7-code",
    modelEnvVar: "RESEARCH_VALUATION_CODER_MODEL",
    promptVersion: "valuation-coder-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "valuation_code_artifact",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "model_name",
        "model_description",
        "files",
        "inputs_required",
        "assumptions",
        "validation_checks",
        "limitations",
        "run_instructions",
      ],
      {
        model_name: { type: "string" },
        model_description: { type: "string" },
        files: objectArray,
        inputs_required: objectArray,
        assumptions: objectArray,
        validation_checks: objectArray,
        limitations: objectArray,
        run_instructions: { type: "string" },
      }
    ),
  },
  "backtest-coder": {
    name: "backtest-coder",
    description: "Generate bounded Python indicator/backtest strategy code.",
    route: "backtest-coder",
    modelTier: "premium",
    defaultModel: "kimi-k2.7-code",
    modelEnvVar: "RESEARCH_BACKTEST_CODER_MODEL",
    promptVersion: "backtest-coder-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "backtest_code_artifact",
    outputSchemaVersion: 1,
    outputFormat: backtestCodegenOutputFormat,
  },
  "research-reviewer": {
    name: "research-reviewer",
    description: "Review research for unsupported claims and category errors.",
    route: "research-reviewer",
    modelTier: "premium",
    defaultModel: "deepseek-v4-pro",
    modelEnvVar: "RESEARCH_RESEARCH_REVIEWER_MODEL",
    promptVersion: "research-reviewer-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "review_findings",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "pass_fail",
        "findings",
        "unsupported_claims",
        "contradictions",
        "category_errors",
        "missing_coverage",
        "valuation_review",
        "backtest_review",
        "escalation_recommendations",
      ],
      {
        pass_fail: { type: "string", enum: ["pass", "needs_more_work", "fail"] },
        findings: objectArray,
        unsupported_claims: objectArray,
        contradictions: objectArray,
        category_errors: objectArray,
        missing_coverage: objectArray,
        valuation_review: objectArray,
        backtest_review: objectArray,
        escalation_recommendations: objectArray,
      }
    ),
  },
  "export-writer": {
    name: "export-writer",
    description: "Generate final research artifacts from accepted records.",
    route: "mid",
    modelTier: "mid",
    defaultModel: "deepseek-v4-pro",
    modelEnvVar: "RESEARCH_MID_MODEL",
    promptVersion: "export-writer-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "export_artifact",
    outputSchemaVersion: 1,
    outputFormat: schema(
      ["artifact_type", "title", "sections", "tables", "charts", "disclosures", "source_index", "open_questions"],
      {
        artifact_type: { type: "string" },
        title: { type: "string" },
        sections: objectArray,
        tables: objectArray,
        charts: objectArray,
        disclosures: stringArray,
        source_index: objectArray,
        open_questions: stringArray,
      }
    ),
  },
  "document-vision-agent": {
    name: "document-vision-agent",
    description: "Inspect visual documents and identify extraction tasks.",
    route: "vision",
    modelTier: "vision",
    defaultModel: "qwen3.7-plus",
    modelEnvVar: "RESEARCH_VISION_MODEL",
    promptVersion: "document-vision-agent-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "visual_regions",
    outputSchemaVersion: 1,
    outputFormat: schema(
      ["visual_regions", "detected_tables", "detected_charts", "layout_notes", "extraction_tasks", "quality_flags"],
      {
        visual_regions: objectArray,
        detected_tables: objectArray,
        detected_charts: objectArray,
        layout_notes: objectArray,
        extraction_tasks: objectArray,
        quality_flags: objectArray,
      }
    ),
  },
  "chart-interpreter-agent": {
    name: "chart-interpreter-agent",
    description: "Interpret charts with uncertainty and source location.",
    route: "vision",
    modelTier: "vision",
    defaultModel: "qwen3.7-plus",
    modelEnvVar: "RESEARCH_VISION_MODEL",
    promptVersion: "chart-interpreter-agent-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "chart_interpretation",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "chart_summary",
        "chart_type",
        "visible_series",
        "approximate_values",
        "trend_interpretation",
        "source_location",
        "confidence",
        "cannot_determine",
      ],
      {
        chart_summary: { type: "string" },
        chart_type: { type: "string" },
        visible_series: objectArray,
        approximate_values: objectArray,
        trend_interpretation: { type: "string" },
        source_location: objectValue,
        confidence: { type: "number", minimum: 0, maximum: 1 },
        cannot_determine: stringArray,
      }
    ),
  },
  "table-vision-agent": {
    name: "table-vision-agent",
    description: "Extract structured rows and columns from visual tables.",
    route: "vision",
    modelTier: "vision",
    defaultModel: "qwen3.7-plus",
    modelEnvVar: "RESEARCH_VISION_MODEL",
    promptVersion: "table-vision-agent-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "visual_table",
    outputSchemaVersion: 1,
    outputFormat: schema(
      ["table_title", "source_location", "columns", "rows", "footnotes", "quality_flags", "confidence"],
      {
        table_title: nullableString,
        source_location: objectValue,
        columns: objectArray,
        rows: objectArray,
        footnotes: stringArray,
        quality_flags: objectArray,
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }
    ),
  },
  "visual-evidence-agent": {
    name: "visual-evidence-agent",
    description: "Convert visual findings into candidate evidence claims.",
    route: "vision",
    modelTier: "vision",
    defaultModel: "qwen3.7-plus",
    modelEnvVar: "RESEARCH_VISION_MODEL",
    promptVersion: "visual-evidence-agent-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "visual_evidence_claim_batch",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "evidence_claims",
        "visual_basis",
        "quoted_visible_text",
        "uncertainty_notes",
        "requires_human_review",
        "rejected_candidates",
      ],
      {
        evidence_claims: objectArray,
        visual_basis: objectArray,
        quoted_visible_text: stringArray,
        uncertainty_notes: objectArray,
        requires_human_review: objectValue,
        rejected_candidates: objectArray,
      }
    ),
  },
  "ui-output-qa-vision-agent": {
    name: "ui-output-qa-vision-agent",
    description: "Visually QA generated dashboards, charts, tables, and memos.",
    route: "vision",
    modelTier: "vision",
    defaultModel: "qwen3.7-plus",
    modelEnvVar: "RESEARCH_VISION_MODEL",
    promptVersion: "ui-output-qa-vision-agent-v1",
    tools: { bash: false, edit: false, write: false },
    outputSchemaKey: "visual_qa_findings",
    outputSchemaVersion: 1,
    outputFormat: schema(
      [
        "qa_status",
        "findings",
        "broken_charts",
        "table_readability",
        "memo_readability",
        "data_display_risks",
        "screenshots_reviewed",
      ],
      {
        qa_status: { type: "string", enum: ["pass", "needs_fix", "fail"] },
        findings: objectArray,
        broken_charts: objectArray,
        table_readability: objectArray,
        memo_readability: objectArray,
        data_display_risks: objectArray,
        screenshots_reviewed: stringArray,
      }
    ),
  },
};

export function isResearchAgentName(value: string): value is ResearchAgentName {
  return (RESEARCH_AGENT_NAMES as readonly string[]).includes(value);
}

export function getAgentConfig(agentName: string): ResearchAgentConfig {
  if (!isResearchAgentName(agentName)) {
    throw new Error(`Unknown Research OS agent: ${agentName}`);
  }
  return AGENT_CONFIGS[agentName];
}

export function resolveAgentModel(agentName: ResearchAgentName, modelOverride?: string): string {
  const config = getAgentConfig(agentName);
  const configured = modelOverride || process.env[config.modelEnvVar] || config.defaultModel;
  return normalizeModelEnvValue(configured);
}

export function listResearchAgents(): ResearchAgentConfig[] {
  return RESEARCH_AGENT_NAMES.map((agentName) => AGENT_CONFIGS[agentName]);
}
