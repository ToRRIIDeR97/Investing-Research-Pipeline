/**
 * Archetype registry for Research OS v3.
 */

import type {
  BusinessArchetype,
  ArchetypeOverlay,
} from "./types";

const commonSourceRoles = (overrides: Partial<Record<string, { required?: boolean; rationale?: string }>> = {}) => {
  const roles = [
    { role: "regulatory_filing", required: true, rationale: "Audited financial statements and disclosures", blockedArtifacts: ["historical_record", "valuation_scenario_set"] },
    { role: "company_investor_relations", required: true, rationale: "Company narrative, guidance, and presentations", blockedArtifacts: ["company_genesis", "segment_model"] },
    { role: "earnings_release", required: true, rationale: "Quarterly results", blockedArtifacts: ["historical_record", "historical_diagnosis"] },
    { role: "earnings_presentation", required: false, rationale: "Management slides and KPIs", blockedArtifacts: ["business_process_map"] },
    { role: "earnings_transcript", required: false, rationale: "Management commentary and Q&A", blockedArtifacts: ["historical_diagnosis", "moat_assessment"] },
    { role: "proxy_and_governance", required: false, rationale: "Ownership, compensation, and governance", blockedArtifacts: ["company_genesis"] },
    { role: "founder_and_company_history", required: true, rationale: "Origins, pivots, and strategic DNA", blockedArtifacts: ["company_genesis", "strategic_dna"] },
    { role: "peer_company_primary", required: true, rationale: "Comparable company economics and share shifts", blockedArtifacts: ["competitive_response_matrix"] },
    { role: "industry_primary", required: true, rationale: "Industry demand, pricing, and regulation", blockedArtifacts: ["operating_model", "driver_tree"] },
    { role: "customer_or_channel", required: false, rationale: "Customer economics and switching behavior", blockedArtifacts: ["customer_decision_map"] },
    { role: "supplier_or_partner", required: false, rationale: "Supply chain and partnership dynamics", blockedArtifacts: ["business_process_map"] },
    { role: "regulatory_or_government", required: false, rationale: "Policy, licensing, and enforcement", blockedArtifacts: ["moat_assessment"] },
    { role: "macro_dataset", required: false, rationale: "Macro drivers affecting demand and pricing", blockedArtifacts: ["operating_scenario_set"] },
    { role: "market_data", required: true, rationale: "Prices, shares, and corporate actions", blockedArtifacts: ["annual_price_target_path", "expected_return_matrix"] },
  ];
  return roles.map((r) => ({
    ...r,
    required: overrides[r.role]?.required ?? r.required,
    rationale: overrides[r.role]?.rationale ?? r.rationale,
  }));
};

const commonArtifacts = (overrides: Partial<Record<string, { required?: boolean; rationale?: string }>> = {}) => {
  const artifacts = [
    { artifact_type: "company_genesis", required: true, scope: "default", rationale: "Why the company began and what remains relevant" },
    { artifact_type: "founder_profile", required: true, scope: "default", rationale: "Founder background and motivations" },
    { artifact_type: "strategic_history_timeline", required: true, scope: "default", rationale: "Defining pivots and consequences" },
    { artifact_type: "strategic_dna", required: true, scope: "default", rationale: "Persistent strategic identity" },
    { artifact_type: "historical_record", required: true, scope: "default", rationale: "Twenty-quarter normalized history" },
    { artifact_type: "historical_diagnosis", required: true, scope: "default", rationale: "What changed and why" },
    { artifact_type: "segment_model", required: true, scope: "default", rationale: "Revenue and profit by segment" },
    { artifact_type: "customer_decision_map", required: true, scope: "default", rationale: "Demand-to-revenue conversion" },
    { artifact_type: "business_process_map", required: true, scope: "default", rationale: "Operating conversion and bottlenecks" },
    { artifact_type: "bottleneck_register", required: true, scope: "default", rationale: "Binding capacity constraints" },
    { artifact_type: "competitive_response_matrix", required: true, scope: "default", rationale: "Active competitor responses" },
    { artifact_type: "moat_assessment", required: true, scope: "default", rationale: "Proven competitive advantages" },
    { artifact_type: "moat_attack_matrix", required: true, scope: "default", rationale: "Moat attack scenarios" },
    { artifact_type: "no_moat_counterfactual", required: true, scope: "default", rationale: "No-moat economics" },
    { artifact_type: "driver_tree", required: true, scope: "default", rationale: "Forecast drivers" },
    { artifact_type: "operating_model", required: true, scope: "default", rationale: "Operational to financial conversion" },
    { artifact_type: "operating_scenario_set", required: true, scope: "default", rationale: "Bear/base/bull operating scenarios" },
    { artifact_type: "top_down_bottom_up_reconciliation", required: true, scope: "default", rationale: "Segment and market reconciliation" },
    { artifact_type: "reinvestment_model", required: true, scope: "default", rationale: "Capital allocation and balance-sheet effects" },
    { artifact_type: "valuation_scenario_set", required: true, scope: "default", rationale: "Valuation outputs per operating scenario" },
    { artifact_type: "annual_price_target_path", required: true, scope: "default", rationale: "Year-by-year price targets" },
    { artifact_type: "reverse_valuation", required: true, scope: "default", rationale: "Implied operating requirements" },
    { artifact_type: "expected_return_matrix", required: true, scope: "default", rationale: "Probability-weighted returns" },
    { artifact_type: "investment_thesis", required: true, scope: "default", rationale: "Synthesized decision thesis" },
    { artifact_type: "risk_register", required: true, scope: "default", rationale: "Identified risks with mechanisms" },
    { artifact_type: "catalyst_register", required: true, scope: "default", rationale: "Event-driven catalysts" },
    { artifact_type: "thesis_breakers", required: true, scope: "default", rationale: "Thresholds that invalidate the thesis" },
    { artifact_type: "monitoring_dashboard", required: true, scope: "default", rationale: "KPIs and thresholds to monitor" },
    { artifact_type: "confidence_assessment", required: true, scope: "default", rationale: "Confidence by analytical area" },
    { artifact_type: "decision_record", required: true, scope: "default", rationale: "Human investment decision" },
  ];
  return artifacts.map((a) => ({
    ...a,
    required: overrides[a.artifact_type]?.required ?? a.required,
    rationale: overrides[a.artifact_type]?.rationale ?? a.rationale,
  }));
};

const commonValuationMethods = (overrides: Partial<Record<string, { allowed?: boolean; required?: boolean; rationale?: string }>> = {}) => {
  const methods = [
    { method: "dcf", allowed: true, required: true, rationale: "Intrinsic cash-flow value" },
    { method: "pe", allowed: true, required: false, rationale: "Earnings multiple cross-check" },
    { method: "ev_ebitda", allowed: true, required: false, rationale: "Operating multiple cross-check" },
    { method: "fcf_yield", allowed: true, required: false, rationale: "Cash-flow yield cross-check" },
    { method: "sotp", allowed: false, required: false, rationale: "Holding-company only" },
    { method: "nav", allowed: false, required: false, rationale: "Asset-heavy or financial only" },
  ];
  return methods.map((m) => ({
    ...m,
    allowed: overrides[m.method]?.allowed ?? m.allowed,
    required: overrides[m.method]?.required ?? m.required,
    rationale: overrides[m.method]?.rationale ?? m.rationale,
  }));
};

export const businessArchetypes: BusinessArchetype[] = [
  {
    key: "operating_company_core",
    name: "Operating Company Core",
    description: "Base archetype for any operating company with revenue, costs, and reinvestment.",
    source_roles: commonSourceRoles(),
    historical_metrics: [
      { metric_family: "income_statement", required: true, minimum_quarters: 20, rationale: "Revenue, margins, and earnings" },
      { metric_family: "balance_sheet", required: true, minimum_quarters: 20, rationale: "Assets, liabilities, and equity" },
      { metric_family: "cash_flow", required: true, minimum_quarters: 20, rationale: "CFO, capex, and free cash flow" },
      { metric_family: "share_count", required: true, minimum_quarters: 20, rationale: "Dilution and buyback effects" },
      { metric_family: "capital_allocation", required: true, minimum_quarters: 20, rationale: "Dividends, buybacks, M&A" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "demand_generation", required: true, rationale: "Where revenue begins" },
      { node_key: "value_delivery", required: true, rationale: "How product/service reaches customer" },
      { node_key: "revenue_recognition", required: true, rationale: "When revenue becomes reported" },
      { node_key: "cash_collection", required: true, rationale: "Cash conversion timing" },
      { node_key: "reinvestment", required: true, rationale: "Capital deployment to sustain growth" },
    ],
    valuation_methods: commonValuationMethods(),
    required_scenario_drivers: [
      { driver_key: "revenue_growth", required: true, rationale: "Top-line trajectory" },
      { driver_key: "operating_margin", required: true, rationale: "Profitability" },
      { driver_key: "reinvestment_rate", required: true, rationale: "Capital required for growth" },
    ],
    monitoring_kpis: [
      { kpi_key: "revenue_growth", frequency: "quarterly", rationale: "Demand health" },
      { kpi_key: "operating_margin", frequency: "quarterly", rationale: "Profitability health" },
      { kpi_key: "free_cash_flow", frequency: "quarterly", rationale: "Cash generation" },
    ],
    optional_branches: [
      { branch_key: "backtest", allowed: true, default_enabled: false, rationale: "Only when timing hypothesis exists" },
    ],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "marketplace",
    name: "Marketplace",
    description: "Two- or multi-sided platform matching buyers and sellers.",
    source_roles: commonSourceRoles({
      customer_or_channel: { required: true, rationale: "Buyer and seller behavior" },
    }),
    historical_metrics: [
      { metric_family: "gmv", required: true, minimum_quarters: 20, rationale: "Gross merchandise volume" },
      { metric_family: "take_rate", required: true, minimum_quarters: 20, rationale: "Platform monetization" },
      { metric_family: "buyer_seller_metrics", required: true, minimum_quarters: 20, rationale: "Active buyers, sellers, listings" },
      { metric_family: "network_kpi", required: true, minimum_quarters: 12, rationale: "Engagement and transactions per user" },
    ],
    required_artifacts: commonArtifacts({
      customer_decision_map: { required: true, rationale: "Both sides of the platform" },
    }),
    required_process_nodes: [
      { node_key: "buyer_acquisition", required: true, rationale: "Demand side" },
      { node_key: "seller_acquisition", required: true, rationale: "Supply side" },
      { node_key: "matching", required: true, rationale: "Discovery and transaction facilitation" },
      { node_key: "take_rate_realization", required: true, rationale: "Monetization capture" },
      { node_key: "trust_and_safety", required: true, rationale: "Retention and fraud prevention" },
    ],
    valuation_methods: commonValuationMethods({
      sotp: { allowed: true, required: false, rationale: "Marketplace can be valued separately" },
    }),
    required_scenario_drivers: [
      { driver_key: "buyers", required: true, rationale: "Demand-side users" },
      { driver_key: "transactions_per_buyer", required: true, rationale: "Purchase frequency" },
      { driver_key: "average_transaction_value", required: true, rationale: "Basket size" },
      { driver_key: "take_rate", required: true, rationale: "Monetization" },
    ],
    monitoring_kpis: [
      { kpi_key: "active_buyers", frequency: "quarterly", rationale: "Demand growth" },
      { kpi_key: "gmv_growth", frequency: "quarterly", rationale: "Platform volume" },
      { kpi_key: "take_rate", frequency: "quarterly", rationale: "Monetization" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "payments_network",
    name: "Payments Network",
    description: "Payment processing and network transaction economics.",
    source_roles: commonSourceRoles({
      regulatory_or_government: { required: true, rationale: "Money transmission and licensing" },
    }),
    historical_metrics: [
      { metric_family: "total_payment_volume", required: true, minimum_quarters: 20, rationale: "TPV" },
      { metric_family: "payment_take_rate", required: true, minimum_quarters: 20, rationale: "Net revenue per dollar processed" },
      { metric_family: "transaction_count", required: true, minimum_quarters: 20, rationale: "Transaction volume" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "payer_acquisition", required: true, rationale: "Payer side" },
      { node_key: "merchant_acquisition", required: true, rationale: "Merchant side" },
      { node_key: "transaction_processing", required: true, rationale: "Authorization and settlement" },
      { node_key: "fraud_management", required: true, rationale: "Risk controls" },
      { node_key: "working_capital_float", required: false, rationale: "Float economics where applicable" },
    ],
    valuation_methods: commonValuationMethods({
      sotp: { allowed: true, required: false, rationale: "Payments segment can be valued separately" },
    }),
    required_scenario_drivers: [
      { driver_key: "tpv", required: true, rationale: "Payment volume" },
      { driver_key: "payment_take_rate", required: true, rationale: "Net take rate" },
      { driver_key: "transaction_margin", required: true, rationale: "Profit per transaction" },
    ],
    monitoring_kpis: [
      { kpi_key: "tpv_growth", frequency: "quarterly", rationale: "Volume growth" },
      { kpi_key: "payment_take_rate", frequency: "quarterly", rationale: "Monetization" },
      { kpi_key: "transaction_margin", frequency: "quarterly", rationale: "Profitability" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "lender",
    name: "Lender / Credit",
    description: "Credit origination, underwriting, and servicing.",
    source_roles: commonSourceRoles({
      regulatory_or_government: { required: true, rationale: "Credit regulation and capital requirements" },
    }),
    historical_metrics: [
      { metric_family: "loan_portfolio", required: true, minimum_quarters: 20, rationale: "Earning assets" },
      { metric_family: "credit_losses", required: true, minimum_quarters: 20, rationale: "Provisions and charge-offs" },
      { metric_family: "net_interest_margin", required: true, minimum_quarters: 20, rationale: "Interest spread" },
      { metric_family: "funding_cost", required: true, minimum_quarters: 20, rationale: "Cost of funds" },
      { metric_family: "delinquency_rate", required: true, minimum_quarters: 20, rationale: "Asset quality" },
      { metric_family: "capital_ratio", required: false, minimum_quarters: 12, rationale: "Regulatory capital" },
    ],
    required_artifacts: commonArtifacts({
      reinvestment_model: { required: true, rationale: "Balance-sheet and capital requirements" },
    }),
    required_process_nodes: [
      { node_key: "customer_underwriting", required: true, rationale: "Credit selection" },
      { node_key: "loan_origination", required: true, rationale: "Disbursement" },
      { node_key: "servicing_and_collections", required: true, rationale: "Repayment and recovery" },
      { node_key: "funding_and_liquidity", required: true, rationale: "Capital structure" },
      { node_key: "credit_loss_recognition", required: true, rationale: "Provisions and charge-offs" },
    ],
    valuation_methods: commonValuationMethods({
      nav: { allowed: true, required: false, rationale: "Credit book can be valued as asset portfolio" },
    }),
    required_scenario_drivers: [
      { driver_key: "loan_origination", required: true, rationale: "New loan volume" },
      { driver_key: "portfolio_yield", required: true, rationale: "Interest income" },
      { driver_key: "credit_loss_rate", required: true, rationale: "Losses" },
      { driver_key: "funding_cost", required: true, rationale: "Cost of funds" },
    ],
    monitoring_kpis: [
      { kpi_key: "loan_portfolio_growth", frequency: "quarterly", rationale: "Volume growth" },
      { kpi_key: "net_interest_margin", frequency: "quarterly", rationale: "Spread" },
      { kpi_key: "credit_loss_rate", frequency: "quarterly", rationale: "Asset quality" },
      { kpi_key: "delinquency_rate", frequency: "quarterly", rationale: "Early warning" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "bank",
    name: "Bank",
    description: "Deposit-taking and regulated lending institution.",
    source_roles: commonSourceRoles({
      regulatory_or_government: { required: true, rationale: "Banking regulation and disclosures" },
    }),
    historical_metrics: [
      { metric_family: "net_interest_income", required: true, minimum_quarters: 20, rationale: "Core banking revenue" },
      { metric_family: "deposit_base", required: true, minimum_quarters: 20, rationale: "Funding stability" },
      { metric_family: "loan_loss_reserve", required: true, minimum_quarters: 20, rationale: "Provisioning" },
      { metric_family: "tier_1_capital", required: true, minimum_quarters: 12, rationale: "Regulatory capital" },
      { metric_family: "non_interest_income", required: true, minimum_quarters: 20, rationale: "Fee income" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "deposit_gathering", required: true, rationale: "Funding" },
      { node_key: "loan_origination", required: true, rationale: "Asset deployment" },
      { node_key: "interest_rate_risk_management", required: true, rationale: "NIM sensitivity" },
      { node_key: "credit_risk_management", required: true, rationale: "Asset quality" },
      { node_key: "regulatory_compliance", required: true, rationale: "Capital and liquidity rules" },
    ],
    valuation_methods: commonValuationMethods({
      nav: { allowed: true, required: true, rationale: "Bank valuation often uses price-to-tangible book" },
      dcf: { allowed: true, required: false, rationale: "DCF possible but capital intensive" },
    }),
    required_scenario_drivers: [
      { driver_key: "loan_growth", required: true, rationale: "Asset growth" },
      { driver_key: "net_interest_margin", required: true, rationale: "Spread" },
      { driver_key: "credit_cost", required: true, rationale: "Provisions" },
      { driver_key: "capital_ratio", required: true, rationale: "Capital constraints" },
    ],
    monitoring_kpis: [
      { kpi_key: "net_interest_margin", frequency: "quarterly", rationale: "Spread" },
      { kpi_key: "credit_cost", frequency: "quarterly", rationale: "Asset quality" },
      { kpi_key: "tier_1_capital_ratio", frequency: "quarterly", rationale: "Capital" },
      { kpi_key: "deposit_growth", frequency: "quarterly", rationale: "Funding" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "logistics_network",
    name: "Logistics Network",
    description: "Physical delivery, warehousing, and fulfillment network.",
    source_roles: commonSourceRoles({
      supplier_or_partner: { required: true, rationale: "Capacity and carrier relationships" },
    }),
    historical_metrics: [
      { metric_family: "packages_shipped", required: true, minimum_quarters: 20, rationale: "Volume" },
      { metric_family: "cost_per_package", required: true, minimum_quarters: 20, rationale: "Unit economics" },
      { metric_family: "network_density", required: true, minimum_quarters: 12, rationale: "Utilization and coverage" },
      { metric_family: "capex_and_depreciation", required: true, minimum_quarters: 20, rationale: "Network investment" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "warehousing", required: true, rationale: "Inventory storage" },
      { node_key: "sortation", required: true, rationale: "Consolidation" },
      { node_key: "last_mile_delivery", required: true, rationale: "Final delivery" },
      { node_key: "reverse_logistics", required: false, rationale: "Returns" },
      { node_key: "capacity_planning", required: true, rationale: "Capex and utilization" },
    ],
    valuation_methods: commonValuationMethods({
      sotp: { allowed: true, required: false, rationale: "Logistics segment can be valued separately" },
    }),
    required_scenario_drivers: [
      { driver_key: "package_volume", required: true, rationale: "Throughput" },
      { driver_key: "cost_per_package", required: true, rationale: "Unit cost" },
      { driver_key: "network_capex", required: true, rationale: "Capacity investment" },
    ],
    monitoring_kpis: [
      { kpi_key: "package_volume_growth", frequency: "quarterly", rationale: "Volume" },
      { kpi_key: "cost_per_package", frequency: "quarterly", rationale: "Unit economics" },
      { kpi_key: "network_utilization", frequency: "quarterly", rationale: "Capacity use" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "advertising_platform",
    name: "Advertising Platform",
    description: "Ad inventory and targeting monetization.",
    source_roles: commonSourceRoles({
      customer_or_channel: { required: true, rationale: "Advertiser ROI and budget owner" },
    }),
    historical_metrics: [
      { metric_family: "ad_revenue", required: true, minimum_quarters: 20, rationale: "Advertising revenue" },
      { metric_family: "ad_impressions", required: true, minimum_quarters: 20, rationale: "Inventory" },
      { metric_family: "cpm_or_cpc", required: true, minimum_quarters: 20, rationale: "Pricing" },
      { metric_family: "advertiser_count", required: true, minimum_quarters: 12, rationale: "Customer base" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "audience_building", required: true, rationale: "Reach" },
      { node_key: "ad_inventory_creation", required: true, rationale: "Impressions" },
      { node_key: "targeting_and_optimization", required: true, rationale: "Ad performance" },
      { node_key: "advertiser_spend_capture", required: true, rationale: "Revenue" },
      { node_key: "measurement_and_attribution", required: true, rationale: "ROI proof" },
    ],
    valuation_methods: commonValuationMethods({
      sotp: { allowed: true, required: false, rationale: "Advertising segment can be valued separately" },
    }),
    required_scenario_drivers: [
      { driver_key: "ad_impressions", required: true, rationale: "Inventory" },
      { driver_key: "cpm", required: true, rationale: "Pricing" },
      { driver_key: "advertiser_count", required: true, rationale: "Customer base" },
    ],
    monitoring_kpis: [
      { kpi_key: "ad_revenue_growth", frequency: "quarterly", rationale: "Revenue growth" },
      { kpi_key: "cpm", frequency: "quarterly", rationale: "Pricing" },
      { kpi_key: "advertiser_count", frequency: "quarterly", rationale: "Customer base" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "subscription_software",
    name: "Subscription Software",
    description: "Recurring subscription revenue with customer cohorts.",
    source_roles: commonSourceRoles(),
    historical_metrics: [
      { metric_family: "arr", required: true, minimum_quarters: 20, rationale: "Annual recurring revenue" },
      { metric_family: "net_revenue_retention", required: true, minimum_quarters: 20, rationale: "Expansion and churn" },
      { metric_family: "customer_acquisition_cost", required: true, minimum_quarters: 12, rationale: "Sales efficiency" },
      { metric_family: "ltv_cac", required: true, minimum_quarters: 12, rationale: "Unit economics" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "product_development", required: true, rationale: "R&D" },
      { node_key: "customer_acquisition", required: true, rationale: "Sales and marketing" },
      { node_key: "onboarding", required: true, rationale: "Activation" },
      { node_key: "retention_and_expansion", required: true, rationale: "Renewals and upsells" },
      { node_key: "support_and_success", required: true, rationale: "Gross retention" },
    ],
    valuation_methods: commonValuationMethods({
      dcf: { allowed: true, required: true, rationale: "DCF with recurring revenue" },
    }),
    required_scenario_drivers: [
      { driver_key: "new_customers", required: true, rationale: "Acquisition" },
      { driver_key: "net_revenue_retention", required: true, rationale: "Expansion/churn" },
      { driver_key: "gross_margin", required: true, rationale: "Software margin" },
      { driver_key: "sales_efficiency", required: true, rationale: "CAC payback" },
    ],
    monitoring_kpis: [
      { kpi_key: "arr_growth", frequency: "quarterly", rationale: "Revenue growth" },
      { kpi_key: "net_revenue_retention", frequency: "quarterly", rationale: "Cohort health" },
      { kpi_key: "gross_margin", frequency: "quarterly", rationale: "Margin" },
      { kpi_key: "ltv_cac", frequency: "quarterly", rationale: "Unit economics" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "consumer_brand",
    name: "Consumer Brand",
    description: "Brand-driven consumer products with distribution channels.",
    source_roles: commonSourceRoles({
      customer_or_channel: { required: true, rationale: "Consumer preference and channel dynamics" },
    }),
    historical_metrics: [
      { metric_family: "brand_revenue", required: true, minimum_quarters: 20, rationale: "Revenue by brand" },
      { metric_family: "gross_margin", required: true, minimum_quarters: 20, rationale: "Brand profitability" },
      { metric_family: "channel_mix", required: true, minimum_quarters: 20, rationale: "DTC vs wholesale" },
      { metric_family: "marketing_spend", required: true, minimum_quarters: 20, rationale: "Brand investment" },
      { metric_family: "inventory_turns", required: true, minimum_quarters: 12, rationale: "Working capital" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "brand_equity", required: true, rationale: "Brand value and awareness" },
      { node_key: "product_creation", required: true, rationale: "Design and sourcing" },
      { node_key: "demand_creation", required: true, rationale: "Marketing" },
      { node_key: "distribution", required: true, rationale: "Channel reach" },
      { node_key: "inventory_management", required: true, rationale: "Working capital" },
    ],
    valuation_methods: commonValuationMethods(),
    required_scenario_drivers: [
      { driver_key: "brand_revenue", required: true, rationale: "Brand sales" },
      { driver_key: "gross_margin", required: true, rationale: "Brand profitability" },
      { driver_key: "marketing_roi", required: true, rationale: "Brand investment efficiency" },
      { driver_key: "inventory_turns", required: true, rationale: "Working capital" },
    ],
    monitoring_kpis: [
      { kpi_key: "brand_revenue_growth", frequency: "quarterly", rationale: "Sales growth" },
      { kpi_key: "gross_margin", frequency: "quarterly", rationale: "Margin" },
      { kpi_key: "marketing_spend_ratio", frequency: "quarterly", rationale: "Investment intensity" },
      { kpi_key: "inventory_turns", frequency: "quarterly", rationale: "Working capital" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "industrial_hardware",
    name: "Industrial Hardware",
    description: "Capital goods and industrial manufacturing.",
    source_roles: commonSourceRoles({
      supplier_or_partner: { required: true, rationale: "Supply chain and components" },
    }),
    historical_metrics: [
      { metric_family: "orders_and_backlog", required: true, minimum_quarters: 20, rationale: "Demand visibility" },
      { metric_family: "capex", required: true, minimum_quarters: 20, rationale: "Capacity investment" },
      { metric_family: "gross_margin", required: true, minimum_quarters: 20, rationale: "Manufacturing margin" },
      { metric_family: "working_capital", required: true, minimum_quarters: 20, rationale: "Inventory and receivables" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "order_intake", required: true, rationale: "Sales pipeline" },
      { node_key: "production", required: true, rationale: "Manufacturing" },
      { node_key: "delivery_and_installation", required: true, rationale: "Revenue recognition" },
      { node_key: "aftermarket_service", required: false, rationale: "Service revenue" },
      { node_key: "capacity_expansion", required: true, rationale: "Capex cycle" },
    ],
    valuation_methods: commonValuationMethods(),
    required_scenario_drivers: [
      { driver_key: "orders", required: true, rationale: "Demand" },
      { driver_key: "gross_margin", required: true, rationale: "Manufacturing margin" },
      { driver_key: "capex_intensity", required: true, rationale: "Capacity investment" },
    ],
    monitoring_kpis: [
      { kpi_key: "orders_growth", frequency: "quarterly", rationale: "Demand" },
      { kpi_key: "backlog", frequency: "quarterly", rationale: "Revenue visibility" },
      { kpi_key: "gross_margin", frequency: "quarterly", rationale: "Margin" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "commodity_producer",
    name: "Commodity Producer",
    description: "Price-taking commodity extraction or production.",
    source_roles: commonSourceRoles({
      macro_dataset: { required: true, rationale: "Commodity price forecasts" },
    }),
    historical_metrics: [
      { metric_family: "production_volume", required: true, minimum_quarters: 20, rationale: "Output" },
      { metric_family: "realized_price", required: true, minimum_quarters: 20, rationale: "Commodity price received" },
      { metric_family: "unit_cost", required: true, minimum_quarters: 20, rationale: "Cost curve position" },
      { metric_family: "reserve_life", required: true, minimum_quarters: 12, rationale: "Reserve replacement" },
    ],
    required_artifacts: commonArtifacts(),
    required_process_nodes: [
      { node_key: "reserve_development", required: true, rationale: "Resource base" },
      { node_key: "production", required: true, rationale: "Extraction" },
      { node_key: "sales_and_pricing", required: true, rationale: "Price realization" },
      { node_key: "cost_management", required: true, rationale: "Cost curve" },
      { node_key: "reinvestment", required: true, rationale: "Reserve replacement" },
    ],
    valuation_methods: commonValuationMethods({
      nav: { allowed: true, required: true, rationale: "Asset-based valuation" },
    }),
    required_scenario_drivers: [
      { driver_key: "commodity_price", required: true, rationale: "External price" },
      { driver_key: "production_volume", required: true, rationale: "Output" },
      { driver_key: "unit_cost", required: true, rationale: "Cost" },
      { driver_key: "capex", required: true, rationale: "Reserve replacement" },
    ],
    monitoring_kpis: [
      { kpi_key: "realized_price", frequency: "quarterly", rationale: "Price" },
      { kpi_key: "unit_cost", frequency: "quarterly", rationale: "Cost" },
      { kpi_key: "production_volume", frequency: "quarterly", rationale: "Output" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "holding_company",
    name: "Holding Company",
    description: "Conglomerate or investment holding structure.",
    source_roles: commonSourceRoles(),
    historical_metrics: [
      { metric_family: "subsidiary_contribution", required: true, minimum_quarters: 20, rationale: "Segment contributions" },
      { metric_family: "net_debt", required: true, minimum_quarters: 20, rationale: "Holdco leverage" },
      { metric_family: "holding_discount", required: false, minimum_quarters: 12, rationale: "Holdco discount" },
    ],
    required_artifacts: commonArtifacts({
      segment_model: { required: true, rationale: "Subsidiary-level valuation" },
    }),
    required_process_nodes: [
      { node_key: "subsidiary_governance", required: true, rationale: "Control and capital allocation" },
      { node_key: "capital_allocation", required: true, rationale: "Dividends and investments" },
      { node_key: "holdco_financing", required: true, rationale: "Leverage and liquidity" },
    ],
    valuation_methods: commonValuationMethods({
      sotp: { allowed: true, required: true, rationale: "Sum-of-the-parts primary" },
    }),
    required_scenario_drivers: [
      { driver_key: "subsidiary_valuations", required: true, rationale: "Underlying value" },
      { driver_key: "holdco_discount", required: true, rationale: "Structural discount" },
      { driver_key: "net_debt", required: true, rationale: "Holdco leverage" },
    ],
    monitoring_kpis: [
      { kpi_key: "nav_premium_discount", frequency: "quarterly", rationale: "Holdco discount" },
      { kpi_key: "net_debt_ebitda", frequency: "quarterly", rationale: "Leverage" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
  {
    key: "etf_fund",
    name: "ETF / Fund",
    description: "Exchange-traded fund or pooled investment vehicle.",
    source_roles: commonSourceRoles({
      regulatory_filing: { required: true, rationale: "Fund prospectus and reports" },
    }),
    historical_metrics: [
      { metric_family: "aum", required: true, minimum_quarters: 20, rationale: "Assets under management" },
      { metric_family: "expense_ratio", required: true, minimum_quarters: 20, rationale: "Fee rate" },
      { metric_family: "flows", required: true, minimum_quarters: 20, rationale: "Net inflows/outflows" },
      { metric_family: "tracking_error", required: true, minimum_quarters: 12, rationale: "Tracking performance" },
    ],
    required_artifacts: commonArtifacts({
      company_genesis: { required: false, rationale: "Fund has no operating history" },
      moat_assessment: { required: false, rationale: "Fund has no moat" },
      no_moat_counterfactual: { required: false, rationale: "Fund has no moat" },
    }),
    required_process_nodes: [
      { node_key: "asset_gathering", required: true, rationale: "AUM growth" },
      { node_key: "portfolio_management", required: true, rationale: "Replication or active management" },
      { node_key: "fee_collection", required: true, rationale: "Revenue" },
    ],
    valuation_methods: commonValuationMethods({
      dcf: { allowed: false, required: false, rationale: "Fund is valued at NAV, not DCF" },
      pe: { allowed: false, required: false, rationale: "No earnings" },
      nav: { allowed: true, required: true, rationale: "Net asset value" },
    }),
    required_scenario_drivers: [
      { driver_key: "aum", required: true, rationale: "Assets under management" },
      { driver_key: "expense_ratio", required: true, rationale: "Fee rate" },
      { driver_key: "flows", required: true, rationale: "Net inflows" },
    ],
    monitoring_kpis: [
      { kpi_key: "aum", frequency: "daily", rationale: "Size" },
      { kpi_key: "flows", frequency: "daily", rationale: "Investor demand" },
      { kpi_key: "expense_ratio", frequency: "annual", rationale: "Fees" },
    ],
    optional_branches: [],
    overlays: [],
    conflicts_with: [],
  },
];

export const archetypeOverlays: ArchetypeOverlay[] = [
  {
    key: "emerging_market_multi_country",
    name: "Emerging Market Multi-Country",
    applies_to: ["operating_company_core", "marketplace", "payments_network", "lender", "logistics_network", "advertising_platform"],
    source_roles: [
      { role: "macro_dataset", required: true, rationale: "Country macro and FX", blockedArtifacts: ["operating_scenario_set"] },
      { role: "regulatory_or_government", required: true, rationale: "Country-specific regulation", blockedArtifacts: ["moat_assessment"] },
    ],
    historical_metrics: [
      { metric_family: "geographic_revenue", required: true, minimum_quarters: 20, rationale: "Revenue by country" },
      { metric_family: "fx_exposure", required: true, minimum_quarters: 20, rationale: "Currency translation" },
      { metric_family: "country_kpi", required: true, minimum_quarters: 12, rationale: "Country-specific KPIs" },
    ],
    required_artifacts: [
      { artifact_type: "geographic_breakdown", required: true, scope: "default", rationale: "Country-level economics" },
    ],
    required_process_nodes: [
      { node_key: "country_regulation", required: true, rationale: "Per-country compliance" },
      { node_key: "cross_border_capital", required: true, rationale: "Capital and cash repatriation" },
      { node_key: "local_competition", required: true, rationale: "Country-specific competitors" },
    ],
    valuation_methods: [
      { method: "sotp", allowed: true, required: false, rationale: "Country-level SOTP possible" },
    ],
    required_scenario_drivers: [
      { driver_key: "country_revenue_share", required: true, rationale: "Country mix" },
      { driver_key: "fx_rate", required: true, rationale: "Currency impact" },
      { driver_key: "country_growth", required: true, rationale: "Per-country growth" },
    ],
    monitoring_kpis: [
      { kpi_key: "revenue_by_country", frequency: "quarterly", rationale: "Country mix" },
      { kpi_key: "fx_adjusted_growth", frequency: "quarterly", rationale: "Local-currency growth" },
      { kpi_key: "regulatory_changes", frequency: "quarterly", rationale: "Country risk" },
    ],
    optional_branches: [],
  },
];

export function getArchetype(key: string): BusinessArchetype | undefined {
  return businessArchetypes.find((a) => a.key === key);
}

export function getOverlay(key: string): ArchetypeOverlay | undefined {
  return archetypeOverlays.find((o) => o.key === key);
}
