// Stage-specific output contracts for artifact-producing handlers.
// Each contract defines the exact keys the model must output, replacing
// the generic "asset-analyst" schema that previously caused contract
// mismatches between agent enforcement and handler persistence.
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { valuationMethodProposal } from "@/lib/agent-harness/registry";

/** Build a schema contract that works with both parseStructuredOutput & validateSchema */
function contract(requiredKeys: string[]): AgentOutputFormat {
  return {
    requiredKeys,
    schema: {
      type: "object",
      required: requiredKeys,
      additionalProperties: true,
    },
  };
}

type JsonSchema = Record<string, unknown>;
const stringSchema = (): JsonSchema => ({ type: "string" });
const enumStringSchema = (values: string[]): JsonSchema => ({ type: "string", enum: values });
const literalStringSchema = (value: string): JsonSchema => ({ type: "string", const: value });
const numberSchema = (): JsonSchema => ({ type: "number" });
const booleanSchema = (): JsonSchema => ({ type: "boolean" });
const arraySchema = (items: JsonSchema, minItems = 1): JsonSchema => ({
  type: "array",
  minItems,
  items,
});
const objectSchema = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties)
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});
const typedContract = (properties: Record<string, JsonSchema>): AgentOutputFormat => ({
  requiredKeys: Object.keys(properties),
  schema: objectSchema(properties),
});

/** Extract one independently executable top-level artifact contract. */
export function contractForArtifact(contract: AgentOutputFormat, artifactKey: string): AgentOutputFormat {
  const schema = contract.schema as { properties?: Record<string, JsonSchema> } | undefined;
  const artifactSchema = schema?.properties?.[artifactKey];
  if (!contract.requiredKeys.includes(artifactKey) || !artifactSchema) {
    throw new Error(`Artifact ${artifactKey} is not declared by the output contract`);
  }
  return {
    requiredKeys: [artifactKey],
    schema: {
      type: "object",
      properties: { [artifactKey]: { ...artifactSchema, additionalProperties: false } },
      required: [artifactKey],
      additionalProperties: false,
    },
  };
}
const stringArray = () => arraySchema(stringSchema());
const evidenceIds = () => arraySchema(stringSchema());
const historicalClaim = () => objectSchema({
  claim: stringSchema(),
  evidence_weight: enumStringSchema([
    "contemporary_direct_founder_statement",
    "later_retrospective_founder_statement",
    "contemporary_third_party_observation",
    "documented_company_action",
    "analyst_inference",
    "disputed_corporate_account",
  ]),
  evidence_claim_ids: evidenceIds(),
  confidence: numberSchema(),
}, ["claim", "evidence_weight", "evidence_claim_ids", "confidence"]);
const motivation = () => objectSchema({
  motivation: enumStringSchema([
    "personal_problem",
    "mission_or_cause",
    "technical_conviction",
    "commercial_opportunity",
    "financial_ambition",
    "competitive_ambition",
    "professional_frustration",
    "status_or_legacy",
    "mixed",
    "unknown",
  ]),
  evidence_claim_ids: evidenceIds(),
  confidence: numberSchema(),
});

/** Contract: company-genesis output */
export const COMPANY_GENESIS_CONTRACT = typedContract({
  company_genesis: objectSchema({
    artifact_type: literalStringSchema("company_genesis"),
    pre_founding_environment: stringSchema(),
    customer_problem: stringSchema(),
    incumbent_failure: stringSchema(),
    enabling_change: stringSchema(),
    founder_background: stringSchema(),
    founder_motivations: arraySchema(motivation()),
    alternative_motivation_interpretations: stringArray(),
    original_product: stringSchema(),
    original_customer: stringSchema(),
    original_geography: stringSchema(),
    original_revenue_model: stringSchema(),
    initial_funding: stringSchema(),
    early_constraints: stringSchema(),
    first_proof_point: stringSchema(),
    present_day_implications: stringArray(),
    material_claims: arraySchema(historicalClaim()),
  }),
  founder_profile: objectSchema({
    artifact_type: literalStringSchema("founder_profile"),
    founder_name: stringSchema(),
    background_summary: stringSchema(),
    motivations: arraySchema(motivation()),
    alternative_interpretations: stringArray(),
    control_evolution: stringSchema(),
    influence_today: stringSchema(),
  }),
  strategic_history_timeline: objectSchema({
    artifact_type: literalStringSchema("strategic_history_timeline"),
    events: arraySchema(objectSchema({
      date_or_period: stringSchema(),
      event: stringSchema(),
      objective_at_the_time: stringSchema(),
      decision: stringSchema(),
      evidence_claim_ids: evidenceIds(),
      immediate_effect: stringSchema(),
      lasting_consequence: stringSchema(),
      strategy_changed: booleanSchema(),
      mission_changed: booleanSchema(),
      confidence: numberSchema(),
    })),
    major_pivots: stringArray(),
  }),
  strategic_dna: objectSchema({
    artifact_type: literalStringSchema("strategic_dna"),
    persistent_behaviors: stringArray(),
    decision_patterns: stringArray(),
    capital_allocation_habits: stringArray(),
    talent_and_organization_patterns: stringArray(),
    historical_evidence: arraySchema(historicalClaim()),
    current_implications: stringArray(),
  }),
});

/** Contract: historical-diagnosis output */
export const HISTORICAL_DIAGNOSIS_CONTRACT = contract([
  "historical_diagnosis",
]);

/** Contract: business-process-analysis output */
export const BUSINESS_PROCESS_CONTRACT = typedContract({
  segment_model: objectSchema({
    artifact_type: literalStringSchema("segment_model"),
    segments: arraySchema(objectSchema({
      segment_name: stringSchema(),
      product_or_service: stringSchema(),
      customer_or_end_user: stringSchema(),
      revenue_model: stringSchema(),
      contract_structure: stringSchema(),
      pricing_unit: stringSchema(),
      costs_and_reinvestment: stringSchema(),
      working_capital_mechanics: stringSchema(),
      suppliers_or_complements: stringArray(),
      competitors_or_substitutes: stringArray(),
      regulation: stringSchema(),
      revenue_recognition_and_cash_conversion_chain: stringSchema(),
      marketplace_details: objectSchema({
        buyers: stringSchema(),
        transactions: stringSchema(),
        gmv: stringSchema(),
        take_rate: stringSchema(),
      }),
      lender_details: objectSchema({
        funding_cost: stringSchema(),
        credit_losses: stringSchema(),
      }),
    }, [
      "segment_name", "product_or_service", "customer_or_end_user", "revenue_model",
      "contract_structure", "pricing_unit", "costs_and_reinvestment",
      "working_capital_mechanics", "suppliers_or_complements", "competitors_or_substitutes",
      "regulation", "revenue_recognition_and_cash_conversion_chain",
    ])),
  }),
  customer_decision_map: objectSchema({
    artifact_type: literalStringSchema("customer_decision_map"),
    customer_groups: arraySchema(objectSchema({
      customer_group: stringSchema(),
      problem_initiating_demand: stringSchema(),
      economic_value_or_roi: stringSchema(),
      budget_owner: stringSchema(),
      alternatives: stringArray(),
      purchase_criteria: stringArray(),
      deployment_constraints: stringArray(),
      renewal_replacement_or_repeat_purchase_mechanism: stringSchema(),
      churn_or_cancellation_triggers: stringArray(),
      switching_or_multihoming_path: stringSchema(),
      time_to_financial_effect: stringSchema(),
    })),
  }),
  business_process_map: objectSchema({
    artifact_type: literalStringSchema("business_process_map"),
    process_nodes: arraySchema(objectSchema({
      process_node: stringSchema(),
      starting_condition: stringSchema(),
      decision_maker: stringSchema(),
      trigger: stringSchema(),
      economic_incentive: stringSchema(),
      required_resources: stringArray(),
      main_constraint: stringSchema(),
      downside_central_upside_outcomes: objectSchema({
        downside: stringSchema(),
        central: stringSchema(),
        upside: stringSchema(),
      }),
      competitive_response: stringSchema(),
      time_lag: stringSchema(),
      financial_line_affected: stringSchema(),
      leading_indicator: stringSchema(),
      failure_condition: stringSchema(),
      supporting_claim_ids: evidenceIds(),
      confidence: numberSchema(),
    })),
  }),
  bottleneck_register: objectSchema({
    artifact_type: literalStringSchema("bottleneck_register"),
    bottlenecks: arraySchema(objectSchema({
      name: stringSchema(),
      description: stringSchema(),
      capacity_limit: numberSchema(),
      unit: stringSchema(),
      current_utilization: numberSchema(),
      mitigation_strategy: stringSchema(),
    })),
  }),
  competitive_response_matrix: objectSchema({
    artifact_type: literalStringSchema("competitive_response_matrix"),
    competitors: arraySchema(objectSchema({
      competitor_name: stringSchema(),
      market_share: numberSchema(),
      main_advantages: stringArray(),
      response_scenarios: arraySchema(objectSchema({
        scenario_name: stringSchema(),
        threat_description: stringSchema(),
        response_mechanism: stringSchema(),
        time_to_response: stringSchema(),
        financial_impact: stringSchema(),
      })),
    })),
  }),
});

/** Contract: moat-analysis output */
export const MOAT_CONTRACT = typedContract({
  moat_assessment: objectSchema({
    artifact_type: stringSchema(),
    assessments: arraySchema(objectSchema({
      claimed_moat: stringSchema(),
      moat_source: stringSchema(),
      protected_profit_pool: stringSchema(),
      customer_consequence: stringSchema(),
      competitor_consequence: stringSchema(),
      company_value_capture: stringSchema(),
      financial_evidence: stringArray(),
      operating_evidence: stringArray(),
      maintenance_requirement: stringSchema(),
      current_strength: stringSchema(),
      durability: stringSchema(),
      decay_velocity: stringSchema(),
      failure_indicators: stringArray(),
      confidence: numberSchema(),
    })),
  }),
  moat_attack_matrix: objectSchema({
    artifact_type: stringSchema(),
    attacks: arraySchema(objectSchema({
      primary_attacker: stringSchema(),
      attack_mechanism: stringSchema(),
      capital_and_time_required: stringSchema(),
      first_vulnerable_customer: stringSchema(),
      switching_path: stringSchema(),
      incumbent_defense: stringSchema(),
      leading_indicators: stringArray(),
      financial_translation: stringSchema(),
      residual_moat: stringSchema(),
    })),
  }),
  no_moat_counterfactual: objectSchema({
    artifact_type: stringSchema(),
    expected_margin_no_moat: numberSchema(),
    expected_growth_no_moat: numberSchema(),
    expected_reinvestment_no_moat: numberSchema(),
    changed_economics_description: stringSchema(),
    bear_case_margin_reconciliation: stringSchema(),
  }),
});

/** Contract: operating-model output */
export const OPERATING_MODEL_CONTRACT = typedContract({
  driver_tree: objectSchema({
    artifact_type: stringSchema(),
    drivers: arraySchema(objectSchema({
      driver_key: stringSchema(),
      formula_decomposition: stringSchema(),
      historical_metric_key: stringSchema(),
      historical_diagnosis_key: stringSchema(),
      process_node_key: stringSchema(),
      assumption_key: stringSchema(),
      time_lag: stringSchema(),
      failure_condition: stringSchema(),
      financial_line_affected: stringSchema(),
    })),
  }),
  operating_model: objectSchema({
    artifact_type: stringSchema(),
    segments: arraySchema(objectSchema({
      segment_name: stringSchema(),
      forecast_revenue: numberSchema(),
      forecast_operating_income: numberSchema(),
    })),
    consolidated_revenue: numberSchema(),
    consolidated_operating_income: numberSchema(),
    credit_capital_required: numberSchema(),
    balance_sheet_effect_present: booleanSchema(),
  }),
  top_down_bottom_up_reconciliation: objectSchema({
    artifact_type: literalStringSchema("top_down_bottom_up_reconciliation"),
    top_down_forecast_total: numberSchema(),
    bottom_up_forecast_total: numberSchema(),
    tam_limit: numberSchema(),
    customer_budget_limit: numberSchema(),
  }),
  reinvestment_model: objectSchema({
    artifact_type: literalStringSchema("reinvestment_model"),
    capex_forecast: arraySchema(numberSchema()),
    working_capital_forecast: arraySchema(numberSchema()),
  }),
});

/** Contract: operating-scenarios output */
export const OPERATING_SCENARIOS_CONTRACT = typedContract({
  operating_scenario_set: objectSchema({
    artifact_type: stringSchema(),
    probability_bear: numberSchema(),
    probability_base: numberSchema(),
    probability_bull: numberSchema(),
    scenarios: arraySchema(objectSchema({
      scenario_type: stringSchema(),
      end_market: stringSchema(),
      customer_economics: stringSchema(),
      customer_spending: stringSchema(),
      competitive_response: stringSchema(),
      capacity: stringSchema(),
      pricing_mix: stringSchema(),
      moat_state: stringSchema(),
      margin_formation: stringSchema(),
      reinvestment: stringSchema(),
      working_capital: stringSchema(),
      balance_sheet: stringSchema(),
      resulting_financial_statements_json: objectSchema({}, []),
    }), 3),
  }),
});

/** Contract: asset-valuation output */
export const VALUATION_CONTRACT = typedContract({
  valuation_scenario_set: objectSchema({
    artifact_type: stringSchema(),
    terminal_year: numberSchema(),
    terminal_anchor_bear: numberSchema(),
    terminal_anchor_base: numberSchema(),
    terminal_anchor_bull: numberSchema(),
    probability_bear: numberSchema(),
    probability_base: numberSchema(),
    probability_bull: numberSchema(),
    uses_adjusted_fcf: booleanSchema(),
    segments_reconciled: booleanSchema(),
  }),
  valuation_method_run: objectSchema({
    artifact_type: literalStringSchema("valuation_method_run"),
    primary_method_key: stringSchema(),
    methods: arraySchema(valuationMethodProposal),
  }),
  reverse_valuation: objectSchema({
    artifact_type: stringSchema(),
    implied_growth: numberSchema(),
    implied_margin: numberSchema(),
    return_on_equity: numberSchema(),
    cost_of_equity: numberSchema(),
    roe_minus_cost_of_equity: numberSchema(),
    roe_vs_coe_assessment: stringSchema(),
  }),
  annual_price_target_path: objectSchema({
    artifact_type: stringSchema(),
    currency: stringSchema(),
    market_price_currency: stringSchema(),
    annual_projections: arraySchema(objectSchema({
      fiscal_year: numberSchema(),
      target_date: stringSchema(),
      operating_values: objectSchema({}, []),
      balance_sheet_values: objectSchema({}, []),
      per_share_values: objectSchema({}, []),
    })),
    price_target_path: arraySchema(objectSchema({
      fiscal_year: numberSchema(),
      scenario_type: stringSchema(),
      valuation_method: stringSchema(),
      operating_metric_key: stringSchema(),
      operating_metric_value: numberSchema(),
      valuation_parameter_key: stringSchema(),
      valuation_parameter_value: numberSchema(),
      price_target: numberSchema(),
      dividend_per_share: numberSchema(),
      total_return_target: numberSchema(),
      is_interpolated: booleanSchema(),
    })),
  }),
});

export const VALUATION_METHOD_SPEC_CONTRACT = typedContract({
  method_spec: valuationMethodProposal,
});

export const VALUATION_EXPLANATION_CONTRACT = typedContract({
  valuation_explanation: objectSchema({
    artifact_type: literalStringSchema("valuation_explanation"),
    method_selection: stringSchema(),
    important_inputs_and_provenance: stringArray(),
    scenario_differences: stringSchema(),
    cross_check_results: stringSchema(),
    reverse_valuation_implications: stringSchema(),
    limitations: stringArray(),
  }),
});

/** Contract: decision-synthesis output */
export const DECISION_SYNTHESIS_CONTRACT = typedContract({
  investment_thesis: objectSchema({
    artifact_type: literalStringSchema("investment_thesis"),
    thesis_statement: stringSchema(),
    causal_chain: stringSchema(),
    market_mispricing: stringSchema(),
    must_be_true: stringArray(),
    disproving_evidence: stringArray(),
    horizon: stringSchema(),
    expected_return_linkage: stringSchema(),
    valuation_accepted_first: booleanSchema(),
  }),
  risk_register: objectSchema({
    artifact_type: literalStringSchema("risk_register"),
    risks: arraySchema(objectSchema({
      risk_name: stringSchema(),
      causal_mechanism: stringSchema(),
      probability: numberSchema(),
      severity: numberSchema(),
      exposure: numberSchema(),
      leading_indicator: stringSchema(),
      failure_threshold: stringSchema(),
      financial_consequence: stringSchema(),
      model_input_affected: stringSchema(),
      mitigants: stringArray(),
      supporting_claim_ids: evidenceIds(),
      confidence: numberSchema(),
    })),
  }),
  catalyst_register: objectSchema({
    artifact_type: literalStringSchema("catalyst_register"),
    catalysts: arraySchema(objectSchema({
      catalyst_name: stringSchema(),
      expected_date_range: stringSchema(),
      event_mechanism: stringSchema(),
      probability: numberSchema(),
      direction: enumStringSchema(["upside", "downside"]),
      model_input_affected: stringSchema(),
      evidence: stringSchema(),
    })),
  }),
  expected_return_matrix: objectSchema({
    artifact_type: literalStringSchema("expected_return_matrix"),
    bear_return: numberSchema(),
    base_return: numberSchema(),
    bull_return: numberSchema(),
    probability_weighted_return: numberSchema(),
    no_rerating_return: numberSchema(),
    weak_stock_outcome: numberSchema(),
    permanent_loss_limit: numberSchema(),
    prediction_date: stringSchema(),
    prediction_price: numberSchema(),
    horizon_months: { type: "number", const: 12 },
    return_unit: literalStringSchema("decimal"),
    benchmark_symbol: stringSchema(),
    currency: stringSchema(),
    rows: arraySchema(objectSchema({
      scenario_type: enumStringSchema(["bear", "base", "bull"]),
      target_date: stringSchema(),
      target_price: numberSchema(),
      dividend_per_share: numberSchema(),
      total_return: numberSchema(),
      probability: numberSchema(),
      weighted_contribution: numberSchema(),
    }), 3),
    dilution_omitted: booleanSchema(),
  }, ["artifact_type", "bear_return", "base_return", "bull_return", "probability_weighted_return", "no_rerating_return", "weak_stock_outcome", "permanent_loss_limit", "dilution_omitted"]),
  thesis_breakers: objectSchema({
    artifact_type: literalStringSchema("thesis_breakers"),
    breakers: arraySchema(objectSchema({
      name: stringSchema(),
      threshold: stringSchema(),
      model_consequence: stringSchema(),
    })),
  }),
  monitoring_dashboard: objectSchema({
    artifact_type: literalStringSchema("monitoring_dashboard"),
    items: arraySchema(objectSchema({
      metric_key: stringSchema(),
      kpi: stringSchema(),
      process_node: stringSchema(),
      current_level: numberSchema(),
      bear_threshold: numberSchema(),
      base_range: stringSchema(),
      bull_threshold: numberSchema(),
      reporting_frequency: stringSchema(),
      model_input_affected: stringSchema(),
      source_role: stringSchema(),
      history: arraySchema(objectSchema({
        period_end: stringSchema(),
        value: numberSchema(),
        unit: stringSchema(),
        currency: { type: ["string", "null"] },
      })),
    }, ["metric_key", "kpi", "process_node", "current_level", "bear_threshold", "base_range", "bull_threshold", "reporting_frequency", "model_input_affected", "source_role"])),
  }),
  confidence_assessment: objectSchema({
    artifact_type: literalStringSchema("confidence_assessment"),
    data: numberSchema(),
    history: numberSchema(),
    process: numberSchema(),
    moat: numberSchema(),
    forecast: numberSchema(),
    valuation: numberSchema(),
    downside: numberSchema(),
  }),
  decision_record: objectSchema({
    artifact_type: literalStringSchema("decision_record"),
    decision: enumStringSchema(["approve", "reject", "pending"]),
    rationale: stringSchema(),
  }),
});

/** Canonical, fail-closed reviewer result for pipeline V4. */
export const AI_REVIEWER_CONTRACT = typedContract({
  pass_fail: enumStringSchema(["pass", "needs_more_work", "fail"]),
  review_summary: { type: "string", minLength: 1 },
  quality_score: { type: "number", minimum: 0, maximum: 100 },
  findings: arraySchema(objectSchema({
    severity: enumStringSchema(["info", "warning", "blocker"]),
    category: stringSchema(),
    message: stringSchema(),
    artifact_refs: arraySchema(stringSchema(), 0),
    evidence_claim_ids: arraySchema(stringSchema(), 0),
  }, ["severity", "category", "message"]), 0),
  recommendations: arraySchema(stringSchema(), 0),
});

/** Map from stage key to its output contract */
export const STAGE_OUTPUT_CONTRACTS: Record<string, AgentOutputFormat> = {
  company_genesis: COMPANY_GENESIS_CONTRACT,
  historical_diagnosis: HISTORICAL_DIAGNOSIS_CONTRACT,
  business_process_analysis: BUSINESS_PROCESS_CONTRACT,
  moat_analysis: MOAT_CONTRACT,
  operating_model: OPERATING_MODEL_CONTRACT,
  operating_scenarios: OPERATING_SCENARIOS_CONTRACT,
  asset_valuation: VALUATION_CONTRACT,
  decision_synthesis: DECISION_SYNTHESIS_CONTRACT,
  ai_reviewer: AI_REVIEWER_CONTRACT,
};

/**
 * Return the stage-specific output contract for a stage key.
 * Returns undefined for stages that don't have a specialized contract
 * (e.g., intake, source_discovery, etc.).
 */
export function getStageOutputContract(stageKey: string): AgentOutputFormat | undefined {
  return STAGE_OUTPUT_CONTRACTS[stageKey];
}
