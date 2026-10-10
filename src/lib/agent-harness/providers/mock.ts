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
  "research-reviewer": { review_summary: "All v3 artifacts are internally consistent.", findings: [{ severity: "info", message: "No issues found.", affected_artifact: "none" }], quality_score: 0.95, recommendations: [{ action: "continue", rationale: "All checks passed." }], review_verdict: "pass" },
  "export-writer": { artifact_type: "report", title: "Investment Research Report", sections: [], tables: [], charts: [], disclosures: [], source_index: [], open_questions: [] },
};

function packetFromPrompt(prompt: string) {
  for (const value of extractJsonObjects(prompt)) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (parsed.asset || parsed.source_corpus || parsed.evidence_claims || parsed.required_modules || parsed.required_lenses || parsed.output_contract) return parsed;
    } catch {}
  }
  return {};
}

function adaptiveReportResponse(packet: Record<string, any>) {
  const artifacts = packet.artifacts as Array<Record<string, any>> || [];
  const evidence = packet.evidence_claims as Array<Record<string, any>> || [];
  const artifactIds = artifacts.map(a => String(a.id));
  if (packet.output_contract === "report_outline") {
    const labels: Record<string, string> = {
      conclusion: "Executive judgment and confidence", ownership: "What the investor owns",
      evidence: "Evidence quality and disclosure limits", history: "What changed in the historical economics",
      business: "How customers become collected cash", constraints: "What limits profitable growth",
      moat: "Competitive advantage under attack", management: "Can shareholders retain the economics?",
      forecasts: "From operating drivers to scenarios", valuation: "Value range and market expectations",
      downside: "Permanent impairment and returns without rerating", monitoring: "What would change the thesis",
    };
    const keys = Object.keys(packet.coverage_requirements || {});
    keys.sort((a,b) => Number(b === "conclusion") - Number(a === "conclusion"));
    return { outline: {
      sections: keys.filter(key=>!["evidence","history","forecasts","downside"].includes(key)).map(key => ({ id: key, title: key==="valuation"?"Valuation":labels[key] || key, purpose: packet.coverage_requirements[key], coverage: key==="business"?["business","evidence","history"]:key==="valuation"?["valuation","forecasts","downside"]:[key], artifact_ids: artifactIds })),
      coverage: keys.map(key => ({ key, status: artifactIds.length ? "satisfied" : "blocked", rationale: "Synthetic fixture exercises coverage; it does not establish real investment quality.", section_ids: [["evidence","history"].includes(key)?"business":["forecasts","downside"].includes(key)?"valuation":key] })),
      questions: [{ id: "cash", question: `Which constraints determine cash reaching holders of ${packet.asset.assetName}?`,
        materiality: "material", status: artifactIds.length ? "answered" : "blocked", answer: "The synthetic operating and valuation artifacts define the modeled cash conversion.",
        evidence_ids: evidence.slice(0,1).map(e => e.id), artifact_ids: artifactIds, follow_up: artifactIds.length ? "" : "Obtain an operating model." }],
    } };
  }
  if (packet.output_contract === "report_section") {
    const section = packet.section_plan;
    const matching = artifacts.find(a => a.artifact_type === ({ history: "historical_record", forecasts: "operating_scenario_set", valuation: "annual_price_target_path" } as Record<string,string>)[section.id]);
    const tablePath = section.id === "history" ? "observations" : section.id === "valuation" ? "price_target_path" : "scenarios";
    return { section: { ...section,
      paragraphs: [
        { kind: "analysis", text: `This synthetic ${section.title.toLowerCase()} analysis traces the supplied operating evidence to shareholder outcomes. Demand must convert to profitable activity, and reinvestment can absorb the resulting cash before it reaches holders.`, evidence_ids: evidence.slice(0,1).map(e => e.id), artifact_ids: artifactIds },
        { kind: "assumption", text: "The scenario depends on sustained customer activity and disciplined reinvestment. If costs rise faster than monetization, the same revenue can produce weaker cash conversion. This is a mock explanation for workflow verification." + (packet.human_revision_request ? " This revised fixture distinguishes spending from returns: spending alone does not demonstrate a profitable investment." : ""), evidence_ids: [], artifact_ids: artifactIds },
      ], counterevidence: "The fixture cannot establish actual customer retention, competitive responses or future capital allocation.",
      implication: "Reassess the relevant operating assumptions when evidence changes; the fixture is not an investment recommendation.",
      gaps: ["Synthetic data cannot establish live investment quality."],
      tables: matching && Object.hasOwn(matching.content_json, tablePath) ? [{ title: "Stored model data", artifact_id: matching.id, path: tablePath }] : [],
    } };
  }
  return STATIC["research-reviewer"];
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
  const topics = [
    ...MODULES,
    ...asset.requiredModules,
    "competitive_position", "management_execution", "capital_allocation", "regulatory_risk",
    "foreign_exchange", "geographic_mix", "market_share", "liquidity",
  ].filter((topic, index, all) => all.indexOf(topic) === index);
  const claims = topics.map((module, index) => {
    const source = sources[index % Math.max(1, sources.length)] || {};
    return {
      claim_text: `${asset.name} ${module.replace(/_/g, " ")} evidence is decision relevant and sufficiently detailed for module-specific mock validation ${index}.`,
      claim_type: "mock_fact", claim_category: "fact", confidence: 0.9,
      source_id: String(source.source_id || "00000000-0000-4000-8000-000000000001"),
      document_chunk_id: source.document_chunk_id,
      char_start: source.char_start,
      char_end: source.char_end,
      quoted_text: String(source.content_excerpt || "").slice(0, 240),
    };
  });
  // The founder pass gets a founder fact from its first passage, as a real reader would.
  const batch = (packet.batch || {}) as Record<string, unknown>;
  const founderSource = batch.required_source_role === "founder_and_company_history" ? sources[0] : undefined;
  if (founderSource) claims.unshift({
    claim_text: `${asset.name} was founded by its mock founding team to serve customers that incumbents underserved.`,
    claim_type: "founder_origin", claim_category: "fact", confidence: 0.9,
    source_id: String(founderSource.source_id), document_chunk_id: founderSource.document_chunk_id,
    char_start: founderSource.char_start, char_end: founderSource.char_end,
    quoted_text: String(founderSource.content_excerpt || "").slice(0, 240),
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
      consolidated_operating_income: 500000000,
      credit_capital_required: 150000000,
      balance_sheet_effect_present: true
    },
    top_down_bottom_up_reconciliation: {
      artifact_type: "top_down_bottom_up_reconciliation",
      top_down_forecast_total: 1200000000,
      bottom_up_forecast_total: 1200000000,
      tam_limit: 2000000000,
      customer_budget_limit: 1500000000
    },
    reinvestment_model: {
      artifact_type: "reinvestment_model",
      capex_forecast: [100000000],
      working_capital_forecast: [50000000]
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
          resulting_financial_statements_json: {},
          maintenance_spend: 5000000,
          revenue_cagr: 0.05,
          operating_margin: 0.12,
          numeric_assumptions:[{driver_key:"revenue_cagr",fiscal_year:2030,value:0.05,unit:"ratio",rationale:"Synthetic downside assumption",source_ids:[]}]
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
          resulting_financial_statements_json: {},
          maintenance_spend: 10000000,
          revenue_cagr: 0.15,
          operating_margin: 0.22,
          numeric_assumptions:[{driver_key:"revenue_cagr",fiscal_year:2030,value:0.15,unit:"ratio",rationale:"Synthetic base assumption",source_ids:[]}]
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
          resulting_financial_statements_json: {},
          maintenance_spend: 15000000,
          revenue_cagr: 0.25,
          operating_margin: 0.32,
          numeric_assumptions:[{driver_key:"revenue_cagr",fiscal_year:2030,value:0.25,unit:"ratio",rationale:"Synthetic upside assumption",source_ids:[]}]
        }
      ]
    }
  };
}

function v3ValuationResponse(packet: Record<string, unknown>) {
  return {
    valuation_scenario_set: {
      artifact_type: "valuation_scenario_set",
      terminal_year: 2030,
      terminal_anchor_bear: 10,
      terminal_anchor_base: 15,
      terminal_anchor_bull: 20,
      uses_adjusted_fcf: true,
      segments_reconciled: true,
      method_inputs:["bear","base","bull"].map((scenario_type,i)=>({method:"fcfe",method_name:"Discounted equity cash flow",scenario_type,rationale:"Synthetic verification fixture",currency:"USD",cash_flow_label:"FCFE",discount_rate:0.1,years:[2026,2027,2028,2029,2030].map(fiscal_year=>({fiscal_year,cash_flow:100*(i+1),build:{starting_profit:100*(i+1),depreciation_amortization:10,capital_expenditures:10,change_in_net_working_capital:0,other_adjustments:0}})),terminal:{type:"perpetuity",growth_rate:0.02},equity_bridge:0,equity_bridge_explanation:"Cash flow is already attributable to equity",diluted_shares:100,source_notes:["Synthetic fixture; not investment analysis"]})),
      omitted_methods:[{method:"book_exit",reason:"Synthetic fixture has no terminal book forecast"}]
    },
    reverse_valuation: {
      artifact_type: "reverse_valuation",
      implied_growth: 0.12,
      implied_margin: 0.20
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
          valuation_method: "reverse_dcf",
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
}

function v3DecisionResponse(packet: Record<string, unknown>) {
  const claimId = evidenceClaimIdFromPacket(packet);
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
      dilution_omitted: false
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
          kpi: "Total member deposits", metric_key:"deposits",definition:"Reported period-end deposits",unit:"USD",reporting_basis:"gaap",
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
    } else if (packet.output_contract === "team_brief") {
      response = { approach: `Synthetic ${packet.role} specialist plan`, checks: ["Verify source coverage and trace assumptions"], information_needed: [] };
    } else if (packet.output_contract === "source_review") {
      response = { sufficient: true, assessment: "Synthetic collector review: the corpus covers the research plan.",
        searches: [], accepted_gaps: ((packet.missing_required_roles as string[]) || []).map(role => ({ source_role: role, reason: "Not available in the synthetic corpus." })) };
    } else if (packet.output_contract === "team_requests") {
      response = { requests: [] };
    } else if (packet.output_contract === "team_answer") {
      // Cite evidence or an artifact; otherwise a retrieved passage's document. Never asks for a re-run.
      const evidence_ids = ((packet.evidence as any[]) || []).slice(0, 1).map(e => e.id);
      const artifact_ids = ((packet.artifacts as any[]) || []).slice(0, 1).map(a => a.id);
      const source_ids = evidence_ids.length || artifact_ids.length ? [] : ((packet.passages as any[]) || []).slice(0, 1).map(p => p.source_id);
      response = evidence_ids.length || artifact_ids.length || source_ids.length
        ? { status: "answered", answer: "Synthetic specialist answer grounded in the supplied research.", evidence_ids, artifact_ids, ...(source_ids.length ? { source_ids } : {}) }
        : { status: "unavailable", answer: "Synthetic specialist answer: nothing in the supplied research can be cited.", evidence_ids: [], artifact_ids: [] };
    } else if (packet.output_contract === "statement_repair_module") {
      response = { rationale: "Locate missing statements by heading words in the candidate's preceding text.", module_source: [
        "function locateStatements(filings) {",
        "  const words = { balance: /balance|financial position|financial condition/i, income: /income|operations|earnings/i, cashflow: /cash flow/i };",
        "  const out = [];",
        "  for (const filing of filings) for (const statement of filing.missing) {",
        "    const hit = filing.candidates.find(c => !c.identified_as && words[statement] && words[statement].test(c.preceding_text.join(' ')));",
        "    if (hit) out.push({ source_document_id: filing.source_document_id, table_index: hit.table_index, statement });",
        "  }",
        "  return out;",
        "}"].join("\n") };
    } else if (packet.output_contract === "research_chat") {
      response = {answer:"This is a synthetic chat response for workflow testing. The selected research and cited source provide the context.", evidence_ids:((packet.evidence as any[])||[]).slice(0,1).map(e=>e.id),proposals:[]};
    } else if (["report_outline", "report_section", "report_review"].includes(String(packet.output_contract))) {
      response = adaptiveReportResponse(packet);
    } else if (request.agentName === "source-reader") {
      response = sourceReaderResponse(packet);
    } else if (request.agentName === "valuation-analyst") {
      response = v3ValuationResponse(packet);
    } else if (request.agentName === "asset-analyst") {
      // Route on the explicit output_contract discriminator (set by stage-specific handlers).
      const contract = packet.output_contract as string | undefined;
      if (contract === "company_genesis") {
        response = v3CompanyGenesisResponse(packet);
      } else if (contract === "historical_diagnosis") {
        response = v3HistoricalDiagnosisResponse(packet);
      } else if (contract === "business_process_analysis") {
        response = v3BusinessProcessResponse(packet);
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
