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
  "tangible_book_value", "ptbv", "roe_vs_coe", "roa", "nim", "credit_losses", "cet1",
  "deposit_mix", "funding_mix", "buyback_capacity",
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
  "metric-normalizer": { normalized_observations: [
    { metric_key: "revenue", display_name: "Total Revenue", metric_category: "income_statement",
      unit_type: "currency", unit: "USD", currency: "USD",
      value_numeric: 689000000, value_text: "$689M",
      period_start: "2024-07-01", period_end: "2024-09-30", as_of_date: "2024-10-29",
      available_at: "2024-10-29T00:00:00Z",
      source: "sofi-10q-q3-2024", confidence: 0.95 },
    { metric_key: "net_income", display_name: "Net Income", metric_category: "income_statement",
      unit_type: "currency", unit: "USD", currency: "USD",
      value_numeric: 61000000, value_text: "$61M",
      period_start: "2024-07-01", period_end: "2024-09-30", as_of_date: "2024-10-29",
      available_at: "2024-10-29T00:00:00Z",
      source: "sofi-10q-q3-2024", confidence: 0.95 },
    { metric_key: "total_members", display_name: "Total Members", metric_category: "operating",
      unit_type: "count", unit: "members", currency: "USD",
      value_numeric: 8600000, value_text: "8.6M",
      period_start: "2024-07-01", period_end: "2024-09-30", as_of_date: "2024-10-29",
      available_at: "2024-10-29T00:00:00Z",
      source: "sofi-10q-q3-2024", confidence: 0.90 },
    { metric_key: "total_products", display_name: "Total Products", metric_category: "operating",
      unit_type: "count", unit: "products", currency: "USD",
      value_numeric: 12800000, value_text: "12.8M",
      period_start: "2024-07-01", period_end: "2024-09-30", as_of_date: "2024-10-29",
      available_at: "2024-10-29T00:00:00Z",
      source: "sofi-10q-q3-2024", confidence: 0.90 },
    { metric_key: "adjusted_ebitda", display_name: "Adjusted EBITDA", metric_category: "income_statement",
      unit_type: "currency", unit: "USD", currency: "USD",
      value_numeric: 186000000, value_text: "$186M",
      period_start: "2024-07-01", period_end: "2024-09-30", as_of_date: "2024-10-29",
      available_at: "2024-10-29T00:00:00Z",
      source: "sofi-10q-q3-2024", confidence: 0.93 }
  ], definition_mappings: [], conversion_notes: [], unresolved_ambiguities: [], quality_flags: [], source_gaps: [] },
  "backtest-coder": { strategy_name: "Mock strategy", strategy_description: "Mock backtest strategy", run_instructions: "Run it", assumptions: [], files: [{ path: "strategy.py", content: "def generate_signals(prices, params):\n    return prices" }] },
  "research-reviewer": { pass_fail: "pass", review_summary: "All v4 artifacts are internally consistent.", quality_score: 95, findings: [{ severity: "info", category: "coverage", message: "No issues found." }], recommendations: ["Continue to human review."] },
  "export-writer": { artifact_type: "report", title: "Investment Research Report", sections: [], tables: [], charts: [], disclosures: [], source_index: [], open_questions: [] },
};

function packetFromPrompt(prompt: string) {
  for (const value of extractJsonObjects(prompt)) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (parsed.asset || parsed.source_corpus || parsed.evidence_claims || parsed.required_modules || parsed.required_lenses ||
          parsed.output_contract || parsed.valuation_method_request || parsed.valuation_explanation_request) return parsed;
    } catch {}
  }
  return {};
}

function assetFromPacket(packet: Record<string, unknown>) {
  const asset = packet.asset && typeof packet.asset === "object"
    ? packet.asset as Record<string, unknown>
    : {};
  const name = String(asset.assetName || asset.canonical_name || asset.symbol || "Test asset");
  const requiredModules = Array.isArray(asset.requiredModules)
    ? asset.requiredModules.map(String)
    : [];
  return { name, requiredModules };
}

function evidenceClaimIdFromPacket(packet: Record<string, unknown>) {
  const allowedClaimIds = Array.isArray(packet.allowed_evidence_claim_ids)
    ? packet.allowed_evidence_claim_ids.map(String).filter(Boolean)
    : [];
  const packetClaimIds = Array.isArray(packet.evidence_claims)
    ? packet.evidence_claims
      .filter((claim): claim is Record<string, unknown> => Boolean(claim) && typeof claim === "object")
      .map((claim) => String(claim.id || ""))
      .filter(Boolean)
    : [];
  return allowedClaimIds[0] || packetClaimIds[0] || "00000000-0000-4000-8000-000000000001";
}

function sourceReaderResponse(packet: Record<string, unknown>) {
  const sources = Array.isArray(packet.source_corpus) ? packet.source_corpus as Array<Record<string, unknown>> : [];
  const asset = assetFromPacket(packet);
  const batch = packet.batch && typeof packet.batch === "object" ? packet.batch as Record<string, unknown> : {};
  const requestedClaims = Number(batch.claim_target);
  const coverageSlots = Array.isArray(batch.coverage_slots) ? batch.coverage_slots.map(String) : [];
  const coverageText: Record<string, string> = {
    consolidated_financials: "revenue adjusted EBITDA net income",
    management_guidance: "management guidance outlook assumptions",
    founder_and_company_history: "founder founded company origin motivation",
    members_by_period: "members by reporting period",
    products_by_period: "total products by reporting period",
    cross_buy: "cross-buy products per member",
    lending_segment: "lending segment contribution profit",
    technology_platform_segment: "technology platform segment contribution profit",
    financial_services_segment: "financial services segment contribution profit",
    deposits_and_capital: "deposits capital ratio",
    loans_and_credit: "loans credit losses",
    funding_cost: "funding cost deposit interest expense",
  };
  const topics = [
    ...asset.requiredModules,
    ...MODULES,
    "competitive_position", "management_execution", "capital_allocation", "regulatory_risk",
    "foreign_exchange", "geographic_mix", "market_share", "liquidity",
  ].filter((topic, index, all) => all.indexOf(topic) === index);
  const claimCount = Number.isFinite(requestedClaims)
    ? Math.max(sources.length, Math.min(topics.length, requestedClaims))
    : topics.length;
  const founderChunk = sources.find((source) => source.source_role === 'founder_and_company_history');
  const coverageTopics = coverageSlots.filter((slot) => slot !== 'founder_and_company_history' || founderChunk).flatMap((slot) =>
    Array.from({ length: ["consolidated_financials", "members_by_period", "products_by_period"].includes(slot) ? 4 : 1 }, () => slot)
  );
  const claims = Array.from({ length: Math.max(claimCount, coverageTopics.length) }, (_, index) => {
    const topic = coverageTopics[index] || topics[index % topics.length];
    const source = (topic === 'founder_and_company_history' ? founderChunk : undefined)
      || sources[index % Math.max(1, sources.length)] || {};
    const quotedText = String(source.content_excerpt || "").slice(0, 500);
    const charStart = Number(source.char_start || 0);
    const founderSource = source.source_role === "founder_and_company_history";
    return {
      claim_text: coverageText[topic]
        ? `${asset.name} ${coverageText[topic]} evidence for ${["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"][index % 4]}.`
        : founderSource
        ? `${asset.name} was founded to solve the customer problem described by this founder-history source.`
        : `${asset.name} ${topic.replace(/_/g, " ")} evidence is decision relevant and sufficiently detailed for module-specific mock validation ${index}.`,
      claim_type: "mock_fact", claim_category: "fact", confidence: 0.9,
      source_id: String(source.source_id || "00000000-0000-4000-8000-000000000001"),
      document_chunk_id: source.document_chunk_id,
      char_start: charStart,
      char_end: charStart + quotedText.length,
      quoted_text: quotedText,
      period_end: ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"][index % 4],
    };
  });
  return { evidence_claims: claims, contradictions: [], source_gaps: [], low_confidence_items: [], rejected_candidates: [] };
}

function analystResponse(packet: Record<string, unknown>) {
  const asset = assetFromPacket(packet);
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
      summary: `${asset.name} ${module.replace(/_/g, " ")} analysis uses supplied evidence and contains enough substantive detail to satisfy the research module contract.`,
      evidence: evidenceIds, evidence_claim_ids: evidenceIds,
      implication: "Material input to the research conclusion and valuation range.", open_questions: [], confidence: 0.9,
    };
  });
  return { analysis_sections: sections, key_drivers: [], metric_interpretation: [], contradictions_or_tensions: [], missing_modules: [], source_gaps: [], analyst_questions: [], confidence: 0.9 };
}

function v3CompanyGenesisResponse(packet: Record<string, unknown>) {
  const asset = assetFromPacket(packet);
  const claimId = evidenceClaimIdFromPacket(packet);
  return {
    company_genesis: {
      artifact_type: "company_genesis",
      pre_founding_environment: `${asset.name} faced a fragmented banking landscape.`,
      customer_problem: "High fees and low access to student loans.",
      incumbent_failure: "Incumbents relied on branches and slow manual underwriting.",
      enabling_change: "Smartphone penetration and digitization.",
      founder_background: "Stanford MBA graduates.",
      founder_motivations: [
        { motivation: "commercial_opportunity", evidence_claim_ids: [claimId], confidence: 0.9 }
      ],
      alternative_motivation_interpretations: ["Some claim it was mission driven."],
      original_product: "Student loan refinancing.",
      original_customer: "Elite graduates with high earnings potential.",
      original_geography: "United States",
      original_revenue_model: "Net interest margin.",
      initial_funding: "Alumni network capital.",
      early_constraints: "Capital constraints.",
      first_proof_point: "Origination growth.",
      present_day_implications: ["Retains refinancing DNA."],
      material_claims: [
        {
          claim: "Founder identified opportunity",
          evidence_weight: "contemporary_direct_founder_statement",
          evidence_claim_ids: [claimId],
          confidence: 0.9
        }
      ]
    },
    founder_profile: {
      artifact_type: "founder_profile",
      founder_name: "Mock Founder",
      background_summary: "Stanford graduates.",
      motivations: [
        { motivation: "financial_ambition", evidence_claim_ids: [claimId], confidence: 0.9 }
      ],
      alternative_interpretations: ["Also motivated by customer pain."],
      control_evolution: "Evolved control.",
      influence_today: "Strong cultural influence."
    },
    strategic_history_timeline: {
      artifact_type: "strategic_history_timeline",
      events: [
        {
          date_or_period: "2011",
          event: "Founded",
          objective_at_the_time: "Help graduates",
          decision: "Launch product",
          evidence_claim_ids: [claimId],
          immediate_effect: "High adoption",
          lasting_consequence: "Established core brand",
          strategy_changed: false,
          mission_changed: false,
          confidence: 0.9
        }
      ],
      major_pivots: ["Pivot into personal lending and Galileo platform."]
    },
    strategic_dna: {
      artifact_type: "strategic_dna",
      persistent_behaviors: ["Focus on high-earning graduates"],
      decision_patterns: ["Rapid expansion"],
      capital_allocation_habits: ["Reinvestment in Galileo"],
      talent_and_organization_patterns: ["Attracting tech talent"],
      historical_evidence: [
        {
          claim: "Focus on high-earning graduates",
          evidence_weight: "contemporary_direct_founder_statement",
          evidence_claim_ids: [claimId],
          confidence: 0.9
        },
        {
          claim: "Rapid expansion into personal lending",
          evidence_weight: "contemporary_direct_founder_statement",
          evidence_claim_ids: [claimId],
          confidence: 0.9
        }
      ],
      current_implications: ["Galileo remains core."]
    }
  };
}

function v3HistoricalDiagnosisResponse(packet: Record<string, unknown>) {
  const claimId = evidenceClaimIdFromPacket(packet);
  return {
    historical_diagnosis: {
      artifact_type: "historical_diagnosis",
      asset_id: "00000000-0000-4000-8000-000000000001",
      diagnoses: [
        {
          metric_key: "revenue",
          current_level: 100,
          historical_mean: 100,
          historical_median: 100,
          historical_min: 90,
          historical_max: 110,
          historical_std_dev: 5,
          trend: "increasing",
          stability: 0.9,
          causal_process_node: "mock_node",
          structural_cyclical_temporary_or_accounting: "structural",
          forecast_implication: "Growth is structural.",
          supporting_claim_ids: [claimId],
          confidence: 0.9
        }
      ],
      unexplained_inflections: []
    }
  };
}

function v3BusinessProcessResponse(packet: Record<string, unknown>) {
  const claimId = evidenceClaimIdFromPacket(packet);
  return {
    segment_model: {
      artifact_type: "segment_model",
      segments: [
        {
          segment_name: "Lending",
          product_or_service: "Loans",
          customer_or_end_user: "Consumers",
          revenue_model: "Interest income",
          contract_structure: "Loan agreement",
          pricing_unit: "Interest rate",
          costs_and_reinvestment: "Funding cost",
          working_capital_mechanics: "Warehouse lines",
          suppliers_or_complements: ["Warehouse lenders"],
          competitors_or_substitutes: ["Banks"],
          regulation: "Banking rules",
          revenue_recognition_and_cash_conversion_chain: "Interest accrual",
          lender_details: {
            funding_cost: "Deposit interest and warehouse fees",
            credit_losses: "Expected credit loss and charge-offs"
          }
        },
        {
          segment_name: "Technology Platform",
          product_or_service: "Galileo API",
          customer_or_end_user: "Fintech enterprise accounts",
          revenue_model: "API call fee",
          contract_structure: "SaaS contract",
          pricing_unit: "Per API call",
          costs_and_reinvestment: "Server hosting",
          working_capital_mechanics: "Receivables",
          suppliers_or_complements: ["Card networks"],
          competitors_or_substitutes: ["Marqeta"],
          regulation: "PCI DSS",
          revenue_recognition_and_cash_conversion_chain: "Monthly SaaS",
          marketplace_details: {
            buyers: "Fintech enterprise accounts",
            transactions: "Digital payment clearing",
            gmv: "Payment volume processed",
            take_rate: "Per API call pricing"
          }
        }
      ]
    },
    customer_decision_map: {
      artifact_type: "customer_decision_map",
      customer_groups: [
        {
          customer_group: "Retail Borrowers",
          problem_initiating_demand: "Consolidate debt",
          economic_value_or_roi: "Lower interest rate",
          budget_owner: "Consumer",
          alternatives: ["LendingClub"],
          purchase_criteria: ["Speed"],
          deployment_constraints: ["Credit score"],
          renewal_replacement_or_repeat_purchase_mechanism: "Refinancing",
          churn_or_cancellation_triggers: ["Late fees"],
          switching_or_multihoming_path: "They refinance with other digital lenders.",
          time_to_financial_effect: "1 day"
        }
      ]
    },
    business_process_map: {
      artifact_type: "business_process_map",
      process_nodes: [
        {
          process_node: "Lending origination",
          starting_condition: "Application submitted",
          decision_maker: "Consumer",
          trigger: "Application click",
          economic_incentive: "Low rates",
          required_resources: ["Underwriting"],
          main_constraint: "Underwriting capacity",
          downside_central_upside_outcomes: {
            downside: "High charge-offs",
            central: "Planned net interest income",
            upside: "Low credit defaults"
          },
          competitive_response: "Aggressive pricing",
          time_lag: "2 days",
          financial_line_affected: "Lending revenue",
          leading_indicator: "Application volume",
          failure_condition: "API gateway downtime",
          supporting_claim_ids: [claimId],
          confidence: 0.9
        }
      ]
    },
    bottleneck_register: {
      artifact_type: "bottleneck_register",
      bottlenecks: [
        {
          name: "Underwriting capacity",
          description: "Manual and automated underwriting rules constrain throughput.",
          capacity_limit: 100000,
          unit: "applications per month",
          current_utilization: 0.8,
          mitigation_strategy: "Machine learning model",
        }
      ]
    },
    competitive_response_matrix: {
      artifact_type: "competitive_response_matrix",
      competitors: [
        {
          competitor_name: "LendingClub",
          market_share: 0.15,
          main_advantages: ["Brand"],
          response_scenarios: [
            {
              scenario_name: "Match pricing",
              threat_description: "Matches interest rate",
              response_mechanism: "Focus on speed",
              time_to_response: "1 month",
              financial_impact: "-1% NIM"
            },
            {
              scenario_name: "Market share loss response",
              threat_description: "Peer loses share",
              response_mechanism: "Peer cuts prices",
              time_to_response: "2 months",
              financial_impact: "-2% NIM"
            }
          ]
        }
      ]
    }
  };
}

function v3MoatResponse(packet: Record<string, unknown>) {
  return {
    moat_assessment: {
      artifact_type: "moat_assessment",
      assessments: [
        {
          claimed_moat: "High switching costs in technology platform",
          moat_source: "switching_costs",
          protected_profit_pool: "SaaS margin",
          customer_consequence: "High integration pain and disruption.",
          competitor_consequence: "Hard to displace once integrated.",
          company_value_capture: "Premium pricing power.",
          financial_evidence: ["Consistent 30%+ operating margin"],
          operating_evidence: ["98%+ retention rate"],
          maintenance_requirement: "Continuous updates",
          current_strength: "strong",
          durability: "high",
          decay_velocity: "slow",
          failure_indicators: ["Client churn"],
          confidence: 0.9
        }
      ]
    },
    moat_attack_matrix: {
      artifact_type: "moat_attack_matrix",
      attacks: [
        {
          primary_attacker: "Marqeta",
          attack_mechanism: "Undercutting pricing",
          capital_and_time_required: "Large sales force and 12 months",
          first_vulnerable_customer: "Small digital banks",
          switching_path: "API migration to competitor",
          incumbent_defense: "Bundle lending or volume discounts",
          leading_indicators: ["API call deceleration"],
          financial_translation: "-10% tech platform revenue",
          residual_moat: "Medium strength"
        }
      ]
    },
    no_moat_counterfactual: {
      artifact_type: "no_moat_counterfactual",
      expected_margin_no_moat: 0.15,
      expected_growth_no_moat: 0.05,
      expected_reinvestment_no_moat: 0.10,
      changed_economics_description: "Commoditization reduces margins.",
      bear_case_margin_reconciliation: "Margins decline to 15%."
    }
  };
}

function v3OperatingModelResponse(packet: Record<string, unknown>) {
  return {
    driver_tree: {
      artifact_type: "driver_tree",
      drivers: [
        {
          driver_key: "members",
          formula_decomposition: "members_growth",
          historical_metric_key: "members",
          historical_diagnosis_key: "members_gain",
          process_node_key: "acquisition",
          assumption_key: "growth_rate",
          time_lag: "none",
          failure_condition: "ad_spend_ineffectiveness",
          financial_line_affected: "revenue"
        }
      ]
    },
    operating_model: {
      artifact_type: "operating_model",
      segments: [
        {
          segment_name: "Lending",
          forecast_revenue: 1200000000,
          forecast_operating_income: 400000000
        }
      ],
      consolidated_revenue: 1200000000,
      consolidated_operating_income: 400000000,
      credit_capital_required: 150000000,
      balance_sheet_effect_present: true
    },
    top_down_bottom_up_reconciliation: {
      artifact_type: "top_down_bottom_up_reconciliation",
      top_down_forecast_total: 1200000000,
      bottom_up_forecast_total: 1200000000,
      tam_limit: 5000000000,
      customer_budget_limit: 2500000000
    },
    reinvestment_model: {
      artifact_type: "reinvestment_model",
      capex_forecast: [100000000, 110000000, 120000000],
      working_capital_forecast: [50000000, 55000000, 60000000]
    }
  };
}

function v3OperatingScenariosResponse(packet: Record<string, unknown>) {
  return {
    operating_scenario_set: {
      artifact_type: "operating_scenario_set",
      probability_bear: 0.20,
      probability_base: 0.60,
      probability_bull: 0.20,
      scenarios: [
        {
          scenario_type: "bear",
          end_market: "Slowdown",
          customer_economics: "Higher delinquency",
          customer_spending: "Weak borrowing",
          competitive_response: "Peers cut rates",
          capacity: "Unchanged",
          pricing_mix: "Lower interest margins",
          moat_state: "Slightly weakened",
          margin_formation: "Margin declines",
          reinvestment: "Reduced corporate marketing spend",
          working_capital: "Unchanged",
          balance_sheet: "Restricted limits",
          resulting_financial_statements_json: { total_revenue: 900000000, net_income: -50000000 },
          maintenance_spend: 5000000,
          revenue_cagr: 0.05,
          operating_margin: 0.12
        },
        {
          scenario_type: "base",
          end_market: "Stable banking adoption",
          customer_economics: "Stable job market",
          customer_spending: "Consistent demand",
          competitive_response: "Moderate intensity",
          capacity: "Adequate capacity",
          pricing_mix: "Stable yields",
          moat_state: "Switching costs retain strength",
          margin_formation: "Consistent leverage",
          reinvestment: "Moderate R&D",
          working_capital: "Unchanged",
          balance_sheet: "Sufficient capital",
          resulting_financial_statements_json: { total_revenue: 1200000000, net_income: 100000000 },
          maintenance_spend: 10000000,
          revenue_cagr: 0.15,
          operating_margin: 0.22
        },
        {
          scenario_type: "bull",
          end_market: "Rapid expansion",
          customer_economics: "Improving balance sheets",
          customer_spending: "Strong cross-buying",
          competitive_response: "Competitors lag",
          capacity: "Abundant capacity",
          pricing_mix: "Increasing yields",
          moat_state: "Network effects strengthen",
          margin_formation: "High operating leverage",
          reinvestment: "Aggressive Galileo expansion",
          working_capital: "Unchanged",
          balance_sheet: "Robust capital",
          resulting_financial_statements_json: { total_revenue: 1500000000, net_income: 250000000 },
          maintenance_spend: 15000000,
          revenue_cagr: 0.25,
          operating_margin: 0.32
        }
      ]
    }
  };
}

function v3ValuationResponse(packet: Record<string, unknown>) {
  const methodRequest = packet.valuation_method_request && typeof packet.valuation_method_request === "object"
    ? packet.valuation_method_request as Record<string, unknown>
    : {};
  const valuationMethod = methodRequest.required_method
    ? String(methodRequest.required_method)
    : Array.isArray(packet.required_lenses) ? String(packet.required_lenses[0] || "reverse_dcf") : "reverse_dcf";
  const marketSnapshot = packet.current_market_snapshot && typeof packet.current_market_snapshot === "object"
    ? packet.current_market_snapshot as Record<string, unknown>
    : {};
  const predictionPrice = Number(marketSnapshot.regular_market_price) > 0
    ? Number(marketSnapshot.regular_market_price)
    : 0.5;
  const operatingScenarios = packet.operating_scenarios && typeof packet.operating_scenarios === "object"
    ? packet.operating_scenarios as Record<string, unknown>
    : {};
  const probabilities = {
    bear: Number(operatingScenarios.probability_bear ?? 0.25),
    base: Number(operatingScenarios.probability_base ?? 0.5),
    bull: Number(operatingScenarios.probability_bull ?? 0.25),
  };
  const protocol = packet.valuation_method_protocol && typeof packet.valuation_method_protocol === "object"
    ? packet.valuation_method_protocol as Record<string, unknown>
    : {};
  const requiredModelKeys = methodRequest.required_method
    ? [String(methodRequest.required_method)]
    : Array.isArray(protocol.required_model_keys) && protocol.required_model_keys.length
    ? protocol.required_model_keys.map(String)
    : [valuationMethod.toLowerCase().replace(/[^a-z0-9]+/g, "_")];
  const methodProposals = requiredModelKeys.map((requiredModelKey) => ({
    protocol_version: "1.0",
    method_key: `${requiredModelKey}_model`,
    method_name: `${requiredModelKey.replace(/_/g, " ")} valuation model`,
    method_version: "1.0.0",
    method_family: "earnings_multiple",
    origin: "composed",
    rationale: "Uses explicit per-share earnings and scenario multiples so every valuation result is independently reproducible.",
    replaces_method_keys: [requiredModelKey],
    inputs: [
      { key: "earnings_per_share", label: "Earnings per share", source: "assumption", value: 0.2, unit: "USD_per_share", currency: "USD", rationale: "Terminal operating scenario assumption" },
      { key: "valuation_multiple", label: "Valuation multiple", source: "assumption", value: 15, unit: "multiple", rationale: "Base scenario market multiple" },
      { key: "return_on_equity", label: "Return on equity", source: "assumption", value: 0.12, unit: "decimal", rationale: "Scenario return assumption" },
      { key: "cost_of_equity", label: "Cost of equity", source: "assumption", value: 0.10, unit: "decimal", rationale: "Required shareholder return" },
    ],
    formulas: [
      { key: "per_share_value", label: "Per-share value", operation: "multiply", args: ["earnings_per_share", "valuation_multiple"], unit: "USD_per_share", currency: "USD" },
    ],
    outputs: { per_share_value: "per_share_value" },
    scenarios: [
      { scenario_name: "Bear", scenario_type: "bear", probability: probabilities.bear, overrides: { valuation_multiple: 10 }, confidence: 0.55, rationale: "Multiple compression" },
      { scenario_name: "Base", scenario_type: "base", probability: probabilities.base, overrides: { valuation_multiple: 15 }, confidence: 0.7, rationale: "Expected operating trajectory" },
      { scenario_name: "Bull", scenario_type: "bull", probability: probabilities.bull, overrides: { valuation_multiple: 20 }, confidence: 0.55, rationale: "Stronger growth and rerating" },
    ],
    tables: [{
      table_key: "valuation_summary",
      title: "Valuation model summary",
      columns: ["value"],
      rows: [{ label: "Per-share value", cells: { value: "per_share_value" } }],
    }],
    limitations: ["The mock valuation uses a simplified earnings multiple for deterministic tests."],
  }));
  if (packet.valuation_explanation_request) {
    return {
      valuation_explanation: {
        artifact_type: "valuation_explanation",
        method_selection: "The required valuation methods were executed independently under the formula-graph protocol.",
        important_inputs_and_provenance: ["Inputs came from the immutable valuation manifest and accepted operating scenarios."],
        scenario_differences: "Bear, base, and bull values reflect the executed scenario overrides.",
        cross_check_results: "All required methods completed and reconciled before the scenario artifacts were created.",
        reverse_valuation_implications: "The reverse valuation records the growth and return assumptions implied by the current price.",
        limitations: ["The explanation does not create or modify valuation numbers."],
      },
    };
  }
  if (methodRequest.required_method) return { method_spec: methodProposals[0] };
  const response = {
    valuation_scenario_set: {
      artifact_type: "valuation_scenario_set",
      terminal_year: 2030,
      terminal_anchor_bear: 2,
      terminal_anchor_base: 3,
      terminal_anchor_bull: 4,
      probability_bear: probabilities.bear,
      probability_base: probabilities.base,
      probability_bull: probabilities.bull,
      uses_adjusted_fcf: true,
      segments_reconciled: true
    },
    valuation_method_run: {
      artifact_type: "valuation_method_run",
      primary_method_key: requiredModelKeys[0],
      methods: methodProposals,
    },
    reverse_valuation: {
      artifact_type: "reverse_valuation",
      implied_growth: 0.12,
      implied_margin: 0.20,
      return_on_equity: 0.12,
      cost_of_equity: 0.10,
      roe_minus_cost_of_equity: 0.02,
      roe_vs_coe_assessment: "ROE exceeds cost of equity by two percentage points, supporting modest book-value compounding."
    },
    annual_price_target_path: {
      artifact_type: "annual_price_target_path",
      currency: "USD",
      market_price_currency: "USD",
      annual_projections: [
        {
          fiscal_year: 2026,
          target_date: "2026-12-31",
          operating_values: { revenue: 2000000000 },
          balance_sheet_values: { assets: 10000000000 },
          per_share_values: { eps: 0.10 }
        },
        {
          fiscal_year: 2027,
          target_date: "2027-12-31",
          operating_values: { revenue: 2300000000 },
          balance_sheet_values: { assets: 11500000000 },
          per_share_values: { eps: 0.12 }
        },
        {
          fiscal_year: 2028,
          target_date: "2028-12-31",
          operating_values: { revenue: 2645000000 },
          balance_sheet_values: { assets: 13225000000 },
          per_share_values: { eps: 0.14 }
        },
        {
          fiscal_year: 2029,
          target_date: "2029-12-31",
          operating_values: { revenue: 3041750000 },
          balance_sheet_values: { assets: 15208750000 },
          per_share_values: { eps: 0.17 }
        },
        {
          fiscal_year: 2030,
          target_date: "2030-12-31",
          operating_values: { revenue: 3498012500 },
          balance_sheet_values: { assets: 17490062500 },
          per_share_values: { eps: 0.20 }
        }
      ],
      price_target_path: [
        {
          fiscal_year: 2026,
          scenario_type: "bear",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.10,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 10,
          price_target: 1.00,
          dividend_per_share: 0,
          total_return_target: 1.00,
          is_interpolated: false
        },
        {
          fiscal_year: 2026,
          scenario_type: "base",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.10,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 15,
          price_target: 1.50,
          dividend_per_share: 0,
          total_return_target: 1.50,
          is_interpolated: false
        },
        {
          fiscal_year: 2026,
          scenario_type: "bull",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.10,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 20,
          price_target: 2.00,
          dividend_per_share: 0,
          total_return_target: 2.00,
          is_interpolated: false
        },
        {
          fiscal_year: 2027,
          scenario_type: "bear",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.12,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 10,
          price_target: 1.20,
          dividend_per_share: 0,
          total_return_target: 1.20,
          is_interpolated: false
        },
        {
          fiscal_year: 2027,
          scenario_type: "base",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.12,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 15,
          price_target: 1.80,
          dividend_per_share: 0,
          total_return_target: 1.80,
          is_interpolated: false
        },
        {
          fiscal_year: 2027,
          scenario_type: "bull",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.12,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 20,
          price_target: 2.40,
          dividend_per_share: 0,
          total_return_target: 2.40,
          is_interpolated: false
        },
        {
          fiscal_year: 2028,
          scenario_type: "bear",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.14,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 10,
          price_target: 1.40,
          dividend_per_share: 0,
          total_return_target: 1.40,
          is_interpolated: false
        },
        {
          fiscal_year: 2028,
          scenario_type: "base",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.14,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 15,
          price_target: 2.10,
          dividend_per_share: 0,
          total_return_target: 2.10,
          is_interpolated: false
        },
        {
          fiscal_year: 2028,
          scenario_type: "bull",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.14,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 20,
          price_target: 2.80,
          dividend_per_share: 0,
          total_return_target: 2.80,
          is_interpolated: false
        },
        {
          fiscal_year: 2029,
          scenario_type: "bear",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.17,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 10,
          price_target: 1.70,
          dividend_per_share: 0,
          total_return_target: 1.70,
          is_interpolated: false
        },
        {
          fiscal_year: 2029,
          scenario_type: "base",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.17,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 15,
          price_target: 2.55,
          dividend_per_share: 0,
          total_return_target: 2.55,
          is_interpolated: false
        },
        {
          fiscal_year: 2029,
          scenario_type: "bull",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.17,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 20,
          price_target: 3.40,
          dividend_per_share: 0,
          total_return_target: 3.40,
          is_interpolated: false
        },
        {
          fiscal_year: 2030,
          scenario_type: "bear",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.20,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 10,
          price_target: 2.00,
          dividend_per_share: 0,
          total_return_target: 2.00,
          is_interpolated: false
        },
        {
          fiscal_year: 2030,
          scenario_type: "base",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.20,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 15,
          price_target: 3.00,
          dividend_per_share: 0,
          total_return_target: 3.00,
          is_interpolated: false
        },
        {
          fiscal_year: 2030,
          scenario_type: "bull",
          valuation_method: valuationMethod,
          operating_metric_key: "eps",
          operating_metric_value: 0.20,
          valuation_parameter_key: "pe_multiple",
          valuation_parameter_value: 20,
          price_target: 4.00,
          dividend_per_share: 0,
          total_return_target: 4.00,
          is_interpolated: false
        }
      ]
    }
  };
  for (const row of response.annual_price_target_path.price_target_path) {
    row.total_return_target = Number(((row.price_target + row.dividend_per_share) / predictionPrice - 1).toFixed(6));
  }
  return response;
}

function v3DecisionResponse(packet: Record<string, unknown>) {
  const claimId = evidenceClaimIdFromPacket(packet);
  const expectedReturn = packet.deterministic_expected_return && typeof packet.deterministic_expected_return === "object"
    ? packet.deterministic_expected_return as Record<string, unknown>
    : {};
  const metricTrends = packet.metric_trends && typeof packet.metric_trends === "object"
    ? packet.metric_trends as Record<string, unknown>
    : {};
  const monitoringMetricKey = Object.keys(metricTrends)[0] || "net_interest_margin";
  return {
    investment_thesis: {
      artifact_type: "investment_thesis",
      thesis_statement: "SoFi has an attractive digital banking growth opportunity.",
      causal_chain: "Deposits lower funding costs -> boosting NIM -> increasing return.",
      market_mispricing: "Market treats SoFi as personal lender.",
      must_be_true: ["Deposit growth continues"],
      disproving_evidence: ["Deposit outflow"],
      horizon: "3-5 years",
      expected_return_linkage: "Tied to base-case return.",
      valuation_accepted_first: true
    },
    risk_register: {
      artifact_type: "risk_register",
      risks: [
        {
          risk_name: "Interest rate cut squeeze",
          causal_mechanism: "Falling rates reduce yields.",
          probability: 0.3,
          severity: 3,
          exposure: 9,
          leading_indicator: "Fed funds rate",
          failure_threshold: "Rate cuts > 150bps",
          financial_consequence: "NIM compression",
          model_input_affected: "net_interest_margin",
          mitigants: ["Increase personal loan mix"],
          supporting_claim_ids: [claimId],
          confidence: 0.9
        }
      ]
    },
    catalyst_register: {
      artifact_type: "catalyst_register",
      catalysts: [
        {
          catalyst_name: "Galileo contract signing",
          expected_date_range: "Q3 2026",
          event_mechanism: "Signing bank onto Galileo API.",
          probability: 0.5,
          direction: "upside",
          model_input_affected: "tech_platform_accounts",
          evidence: "Management hints"
        }
      ]
    },
    expected_return_matrix: {
      artifact_type: "expected_return_matrix",
      bear_return: 0.05,
      base_return: 0.15,
      bull_return: 0.25,
      probability_weighted_return: 0.15,
      no_rerating_return: 0.10,
      weak_stock_outcome: 0.05,
      permanent_loss_limit: 0.20,
      dilution_omitted: false,
      ...expectedReturn,
    },
    thesis_breakers: {
      artifact_type: "thesis_breakers",
      breakers: [
        {
          name: "Lending charge-offs exceed 6%",
          threshold: "6.0%",
          model_consequence: "Bridges segment margins."
        }
      ]
    },
    monitoring_dashboard: {
      artifact_type: "monitoring_dashboard",
      items: [
        {
          metric_key: monitoringMetricKey,
          kpi: "Total member deposits",
          process_node: "Deposit acquisition",
          current_level: 21000000000,
          bear_threshold: 18000000000,
          base_range: "21B-23B",
          bull_threshold: 25000000000,
          reporting_frequency: "quarterly",
          model_input_affected: "deposit_balance",
          source_role: "regulatory_filing"
        }
      ]
    },
    confidence_assessment: {
      artifact_type: "confidence_assessment",
      data: 0.8,
      history: 0.8,
      process: 0.8,
      moat: 0.8,
      forecast: 0.8,
      valuation: 0.8,
      downside: 0.8
    },
    decision_record: {
      artifact_type: "decision_record",
      decision: "pending",
      rationale: "Requires committee review."
    }
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

    let response: any = STATIC[request.agentName || ""] || { status: "success", data: "mock payload" };

    if (this.config.responseText) {
      response = this.config.responseText;
    } else if (request.agentName === "source-reader") {
      response = sourceReaderResponse(packet);
    } else if (request.agentName === "valuation-analyst") {
      response = v3ValuationResponse(packet);
    } else if (request.agentName === 'export-writer' && packet.output_contract === 'report_composition') {
      response = {
        executive_summary: 'The investment case depends on the operating assumptions and risks set out in the accepted research.',
        section_order: Array.from({ length: 25 }, (_, index) => index + 1),
        transitions: [{ before_section: 16, text: 'The valuation translates those operating assumptions into scenario outcomes.' }],
        closing_assessment: 'Human approval is required before acting on this research.',
        disclosures: ['This is a synthetic test report.'],
        artifact_refs: ['investment_thesis'],
      };
    } else if (request.agentName === 'research-reviewer' && (packet.section || packet.section_reviews)) {
      response = { ...(STATIC['research-reviewer'] as Record<string, unknown>), findings: Array.isArray(packet.section_reviews)
        ? packet.section_reviews.flatMap((section: any) => section.findings || []) : [] };
    } else if (request.agentName === "asset-analyst") {
      // Route on the explicit output_contract discriminator (set by stage-specific handlers).
      const contract = packet.output_contract as string | undefined;
      if (['founder_profile', 'strategic_history_timeline', 'strategic_dna', 'company_genesis'].includes(contract || '') &&
        (packet.output_schema as any)?.required?.length === 1) {
        const artifacts = v3CompanyGenesisResponse(packet);
        response = { [contract!]: artifacts[contract as keyof typeof artifacts] };
      } else if (['moat_assessment', 'moat_attack_matrix', 'no_moat_counterfactual'].includes(contract || '')) {
        const artifacts = v3MoatResponse(packet);
        response = { [contract!]: artifacts[contract as keyof typeof artifacts] };
      } else if (['driver_tree', 'operating_model', 'reinvestment_model', 'top_down_bottom_up_reconciliation'].includes(contract || '') &&
        (packet.output_schema as any)?.required?.length === 1) {
        const artifacts = v3OperatingModelResponse(packet);
        response = { [contract!]: artifacts[contract as keyof typeof artifacts] };
      } else if (contract === "company_genesis") {
        response = v3CompanyGenesisResponse(packet);
      } else if (contract === "historical_diagnosis") {
        response = v3HistoricalDiagnosisResponse(packet);
      } else if (contract === "business_process_analysis") {
        response = v3BusinessProcessResponse(packet);
      } else if ([
        "segment_model", "customer_decision_map", "business_process_map",
        "bottleneck_register", "competitive_response_matrix",
      ].includes(contract || "")) {
        const artifacts = v3BusinessProcessResponse(packet);
        response = { [contract!]: artifacts[contract as keyof typeof artifacts] };
      } else if (contract === "moat_analysis") {
        response = v3MoatResponse(packet);
      } else if (contract === "operating_model") {
        response = v3OperatingModelResponse(packet);
      } else if (contract === "operating_scenarios") {
        response = v3OperatingScenariosResponse(packet);
      } else if (contract === "asset_valuation") {
        response = v3ValuationResponse(packet);
      } else if (contract === "decision_synthesis") {
        response = v3DecisionResponse(packet);
      } else if ([
        "investment_thesis", "risk_register", "catalyst_register", "expected_return_matrix",
        "thesis_breakers", "monitoring_dashboard", "confidence_assessment", "decision_record",
      ].includes(contract || "")) {
        const artifacts = v3DecisionResponse(packet);
        response = { [contract!]: artifacts[contract as keyof typeof artifacts] };
      } else if (contract === "ai_reviewer") {
        response = STATIC["research-reviewer"];
      } else {
        // Fall back to generic analyst response for unrecognized contracts
        response = analystResponse(packet);
      }
    }

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
