export const RESEARCH_PIPELINE_VERSION = 2;

export type V2ProfileKey =
  | "operating_company"
  | "financials"
  | "bitcoin"
  | "commodity_energy"
  | "etf_fund";

export interface ResearchProfileContract {
  profileKey: V2ProfileKey;
  requiredSourceFamilies: string[];
  requiredModules: string[];
  requiredMetricKeys: string[];
  valuationModelKeys: string[];
  minIndicators: number;
  minExecutedCombinations: number;
}

const contracts: Record<V2ProfileKey, ResearchProfileContract> = {
  operating_company: {
    profileKey: "operating_company",
    requiredSourceFamilies: ["filing", "investor_relations", "market_data", "peer_industry"],
    requiredModules: ["business_segments", "revenue_drivers", "margins", "fcf", "capex", "working_capital", "net_debt", "share_count"],
    requiredMetricKeys: ["revenue", "operating_income", "operating_cash_flow", "capex", "cash_and_equivalents", "total_debt", "shares_outstanding"],
    valuationModelKeys: ["driver_based_dcf", "reverse_dcf"],
    minIndicators: 10,
    minExecutedCombinations: 50,
  },
  financials: {
    profileKey: "financials",
    requiredSourceFamilies: ["filing", "regulatory", "market_data", "peer_industry"],
    requiredModules: ["tangible_book_value", "roe_vs_coe", "nim", "credit_losses", "cet1", "deposit_mix", "funding_mix"],
    requiredMetricKeys: ["tangible_book_value", "roe", "net_interest_margin", "credit_losses", "cet1_ratio"],
    valuationModelKeys: ["residual_income_valuation"],
    minIndicators: 10,
    minExecutedCombinations: 50,
  },
  bitcoin: {
    profileKey: "bitcoin",
    requiredSourceFamilies: ["onchain_data", "market_data", "regulatory"],
    requiredModules: ["mvrv", "realized_price", "drawdown", "network_value", "hash_rate", "etf_flows", "liquidity_cycle", "regulatory_regime"],
    requiredMetricKeys: ["mvrv", "realized_price", "hash_rate", "etf_net_flows"],
    valuationModelKeys: ["cycle_value_model"],
    minIndicators: 10,
    minExecutedCombinations: 50,
  },
  commodity_energy: {
    profileKey: "commodity_energy",
    requiredSourceFamilies: ["market_data", "supply_demand", "macro"],
    requiredModules: ["real_price_percentile", "inventories", "futures_curve", "marginal_cost", "spare_capacity", "demand_growth"],
    requiredMetricKeys: ["spot_price", "inventory", "futures_curve", "spare_capacity", "demand_growth"],
    valuationModelKeys: ["commodity_balance_model"],
    minIndicators: 10,
    minExecutedCombinations: 50,
  },
  etf_fund: {
    profileKey: "etf_fund",
    requiredSourceFamilies: ["issuer_report", "market_data", "portfolio_holdings"],
    requiredModules: ["nav", "nav_per_share", "discount_premium_to_nav", "portfolio_composition", "leverage", "capital_allocation"],
    requiredMetricKeys: ["nav", "nav_per_share", "expense_ratio", "tracking_error"],
    valuationModelKeys: ["fund_nav_model"],
    minIndicators: 10,
    minExecutedCombinations: 50,
  },
};

const fintechOverlay: Partial<ResearchProfileContract> = {
  requiredSourceFamilies: ["filing", "investor_relations", "market_data", "peer_industry"],
  requiredModules: ["gmv", "tpv", "active_buyers", "fintech_mau", "loan_book", "provisions", "net_interest_margin_after_losses", "customer_funds", "funding_liabilities"],
  requiredMetricKeys: ["revenue", "gmv", "tpv", "fintech_mau", "loan_book", "provisions", "net_interest_margin_after_losses", "customer_funds"],
  valuationModelKeys: ["fintech_platform_sotp"],
};

/** Compatibility for v2 test runs written before the NIMAL typo was corrected. */
export function canonicalResearchKey(key: string) {
  return key === "nimal" ? "net_interest_margin_after_losses" : key;
}

export function contractForProfile(profileKey: string, assetSlug?: string): ResearchProfileContract | null {
  const contract = contracts[profileKey as V2ProfileKey];
  if (!contract) return null;
  if (profileKey === "operating_company" && assetSlug === "mercado-libre") {
    return {
      ...contract,
      requiredModules: [...contract.requiredModules, ...(fintechOverlay.requiredModules || [])],
      requiredMetricKeys: [...contract.requiredMetricKeys, ...(fintechOverlay.requiredMetricKeys || [])],
      valuationModelKeys: fintechOverlay.valuationModelKeys || contract.valuationModelKeys,
    };
  }
  return contract;
}

export function sourceFamiliesPresent(sources: Array<Record<string, unknown>>) {
  const text = sources
    .map((source) => [source.source_type, source.title, source.publisher, source.url, JSON.stringify(source.metadata_json || {})].join(" ").toLowerCase())
    .join("\n");
  return new Set([
    ...(text.match(/sec|filing|annual report|quarterly report|20-f|40-f|10-k|10-q/g) ? ["filing"] : []),
    ...(text.match(/investor|earnings|presentation|shareholder|exhibit/g) ? ["investor_relations"] : []),
    ...(text.match(/yahoo|market_data|price|fred|finance/g) ? ["market_data"] : []),
    ...(text.match(/peer|industry|sector/g) ? ["peer_industry"] : []),
    ...(text.match(/regulatory|fdic|fed|sec/g) ? ["regulatory"] : []),
    ...(text.match(/onchain|on-chain|hash rate|blockchain/g) ? ["onchain_data"] : []),
    ...(text.match(/eia|inventory|opec|cftc|supply|demand/g) ? ["supply_demand"] : []),
    ...(text.match(/macro|fred|treasury|inflation/g) ? ["macro"] : []),
    ...(text.match(/issuer|fund report|prospectus/g) ? ["issuer_report"] : []),
    ...(text.match(/holdings|n-port|portfolio/g) ? ["portfolio_holdings"] : []),
  ]);
}
