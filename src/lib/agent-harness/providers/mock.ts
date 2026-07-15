import { ProviderError } from "../errors";
import { extractJsonObjects } from "../output-parser";
import type { ModelEvent, ModelProvider, ModelRequest } from "../types";

export interface MockProviderConfig {
  scenario: "success" | "slow_stream" | "inactivity_timeout" | "rate_limit" | "auth_error" | "malformed_json" | "cancellation";
  responseText?: string;
  delayMs?: number;
}

const MODULES = [
  "business_segments", "revenue_drivers", "unit_economics", "margins", "roic", "fcf", "capex",
  "working_capital", "net_debt", "share_count", "driver_based_dcf", "exit_multiple_dcf", "reverse_dcf",
  "gmv", "tpv", "active_buyers", "fintech_mau", "loan_book", "provisions",
  "net_interest_margin_after_losses", "customer_funds", "funding_liabilities",
];

const STATIC: Record<string, unknown> = {
  "intake-planner": {
    objective: "MELI deep dive", asset_hypothesis: {}, run_type: "full_research", required_modules: MODULES,
    source_strategy: [], planned_agent_tasks: [], approval_questions: [], source_gaps: [], risk_flags: [], confidence: 0.9,
  },
  "asset-classifier": {
    selected_profile_key: "operating_company", selected_profile_name: "Operating Company", confidence: 0.9,
    asset_kind: "equity", identity_resolution: {}, required_modules: MODULES, rejected_profiles: [],
    classification_evidence: [], ambiguities: [], recommended_next_tasks: [],
  },
  "source-discovery-agent": { source_candidates: [], required_primary_sources: [], secondary_sources: [], source_gaps: [], freshness_constraints: [], risk_flags: [], recommended_ingestion_tasks: [] },
  "table-normalizer": { metric_observations: [], table_mapping: {}, unmapped_cells: [], normalization_warnings: [], requires_vision_escalation: {}, source_gaps: [] },
  "metric-normalizer": { normalized_observations: [], definition_mappings: [], conversion_notes: [], unresolved_ambiguities: [], quality_flags: [], source_gaps: [] },
  "backtest-coder": { strategy_name: "Mock strategy", strategy_description: "Mock backtest strategy", run_instructions: "Run it", assumptions: [], files: [{ path: "strategy.py", content: "def generate_signals(prices, params):\n    return prices" }] },
  "research-reviewer": { pass_fail: "pass", findings: [], unsupported_claims: [], contradictions: [], category_errors: [], missing_coverage: [], valuation_review: [], backtest_review: [], escalation_recommendations: [] },
  "export-writer": { artifact_type: "report", title: "MercadoLibre Deep Dive", sections: [], tables: [], charts: [], disclosures: [], source_index: [], open_questions: [] },
};

function packetFromPrompt(prompt: string) {
  for (const value of extractJsonObjects(prompt)) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (parsed.asset || parsed.source_corpus || parsed.evidence_claims || parsed.required_modules) return parsed;
    } catch {}
  }
  return {};
}

function sourceReaderResponse(packet: Record<string, unknown>) {
  const sources = Array.isArray(packet.source_corpus) ? packet.source_corpus as Array<Record<string, unknown>> : [];
  const topics = [
    ...MODULES,
    "competitive_position", "management_execution", "capital_allocation", "regulatory_risk",
    "foreign_exchange", "geographic_mix", "market_share", "liquidity",
  ];
  const claims = topics.map((module, index) => {
    const source = sources[index % Math.max(1, sources.length)] || {};
    return {
    claim_text: `MercadoLibre ${module.replace(/_/g, " ")} evidence is decision relevant and sufficiently detailed for module-specific mock validation ${index}.`,
    claim_type: "mock_fact", claim_category: "fact", confidence: 0.9,
    source_id: String(source.source_id || "00000000-0000-4000-8000-000000000001"),
    document_chunk_id: source.document_chunk_id,
    char_start: source.char_start,
    char_end: source.char_end,
    quoted_text: String(source.content_excerpt || "").slice(0, 500),
    };
  });
  return { evidence_claims: claims, contradictions: [], source_gaps: [], low_confidence_items: [], rejected_candidates: [] };
}

function analystResponse(packet: Record<string, unknown>) {
  const requested = Array.isArray(packet.required_modules) ? packet.required_modules.map(String) : MODULES;
  const evidence = Array.isArray(packet.evidence_claims) ? packet.evidence_claims as Array<Record<string, unknown>> : [];
  const allIds = evidence.map((claim) => String(claim.id || "")).filter(Boolean);
  const sections = requested.map((module) => {
    const terms = module.replace(/^net_interest_margin_after_losses$/, "nimal interest margin loss").split(/[_ ]/).filter((term) => term.length >= 3);
    const ids = evidence.filter((claim) => terms.some((term) => String(claim.claim_text || "").toLowerCase().includes(term)))
      .map((claim) => String(claim.id || "")).filter(Boolean);
    const evidenceIds = ids.length ? ids : allIds.slice(0, 3);
    return {
      section_key: module, title: module.replace(/_/g, " "),
      summary: `MercadoLibre ${module.replace(/_/g, " ")} analysis uses supplied evidence and contains enough substantive detail to satisfy the research module contract.`,
      evidence: evidenceIds, evidence_claim_ids: evidenceIds,
      implication: "Material input to the research conclusion and valuation range.", open_questions: [], confidence: 0.9,
    };
  });
  return { analysis_sections: sections, key_drivers: [], metric_interpretation: [], contradictions_or_tensions: [], missing_modules: [], source_gaps: [], analyst_questions: [], confidence: 0.9 };
}

function valuationResponse(packet: Record<string, unknown>) {
  const lenses = Array.isArray(packet.required_lenses) ? packet.required_lenses.map(String) : ["reverse_dcf"];
  return {
    applicable_methods: [{ method_key: "reverse_dcf", reason: "Supported by the supplied mock packet." }],
    not_applicable_methods: [],
    valuation_signals: lenses.map((lens) => ({
      signal_key: `mock_${lens}`, signal_name: `${lens} mock signal`, lens_family: lens,
      current_value_text: "Mock valuation signal for pipeline validation.", comparison_range_json: { low: 3500, high: 5000 },
      signal: "fair", cheapness_score: 0.5, cheaper_when: "lower", confidence: 0.8,
    })),
    scenarios: [
      { scenario_name: "Bear", scenario_type: "bear", value_anchor: 3500, assumptions_json: [], confidence: 0.7 },
      { scenario_name: "Base", scenario_type: "base", value_anchor: 4250, assumptions_json: [], confidence: 0.8 },
      { scenario_name: "Bull", scenario_type: "bull", value_anchor: 5000, assumptions_json: [], confidence: 0.7 },
    ],
    assumptions: [], sensitivity_notes: [{ note: "Mock-only sensitivity output." }],
    method_risks: [{ risk: "Mock values are not investment conclusions." }], source_gaps: [],
  };
}

export class MockProvider implements ModelProvider {
  readonly id = "mock";
  constructor(private config: MockProviderConfig = { scenario: "success" }) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (this.config.scenario === "auth_error") throw new ProviderError("Mock authentication failure", "authentication");
    if (this.config.scenario === "rate_limit") throw new ProviderError("Mock rate limit", "rate_limit", { retryAfter: 0.001 });
    yield { type: "response.started", requestId: "mock-request" };
    const packet = packetFromPrompt(request.prompt);
    const response = this.config.responseText || (request.agentName === "source-reader"
      ? sourceReaderResponse(packet)
      : request.agentName === "asset-analyst"
        ? analystResponse(packet)
        : request.agentName === "valuation-analyst"
          ? valuationResponse(packet)
        : STATIC[request.agentName || ""] || { status: "success", data: "mock payload" });
    const text = typeof response === "string" ? response : JSON.stringify(response);
    const output = this.config.scenario === "malformed_json" ? `${text.slice(0, Math.max(1, text.length - 3))}` : text;
    const chunks = output.match(/[\s\S]{1,256}/g) || [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (signal.aborted || this.config.scenario === "cancellation") throw new ProviderError("Mock request cancelled", "cancellation");
      if (this.config.scenario === "inactivity_timeout" && index === 1) {
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError("Mock request cancelled", "cancellation")), { once: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.scenario === "slow_stream" ? 50 : this.config.delayMs ?? 1));
      yield { type: "text.delta", text: chunks[index] };
    }
    yield { type: "usage", usage: { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: Math.ceil(output.length / 4), costUsd: 0 } };
    yield { type: "response.completed", finishReason: "stop" };
  }
}
