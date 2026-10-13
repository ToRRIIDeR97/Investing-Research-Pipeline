// What evidence extraction asks the corpus for, per source role.
import type { RetrievalNeed } from "./retrieve";

export const FOUNDER_ORIGIN_NEED: RetrievalNeed = {
  key: "founder_origin",
  query: "founder founders co-founder cofounder founded founding history origin origins started began launched",
  sourceRoles: ["founder_and_company_history"],
  maxPassages: 6,
};

/** Filings and investor material often state the founding ("SoFi ... was founded in 2011 to ..."). */
export const FOUNDER_FILINGS_NEED: RetrievalNeed = {
  key: "founder_origin_filings",
  query: "founded founder founders co-founder cofounder founding history organization origin",
  sourceRoles: ["regulatory_filing", "company_investor_relations", "proxy_and_governance"],
  maxPassages: 3,
};

/** Needs whose passages the founder pass reads, founder-history documents first. */
export const FOUNDER_NEED_KEYS = [FOUNDER_ORIGIN_NEED.key, FOUNDER_FILINGS_NEED.key];

const ROLE_QUERIES: Record<string, string> = {
  regulatory_filing: "revenue segment margin operating income cash flow working capital credit loss loan customer funds liquidity risk",
  company_investor_relations: "strategy business model segment customers products growth platform",
  earnings_release: "revenue net income growth margin quarter results guidance",
  earnings_exhibit: "revenue net income growth margin quarter results guidance",
  earnings_presentation: "revenue growth margin users volume guidance outlook",
  earnings_transcript: "guidance outlook margin growth competition demand investment",
  proxy_and_governance: "compensation incentive board director ownership shareholder",
  peer_company_primary: "competition market share revenue growth pricing customers",
  industry_primary: "market size industry growth competition regulation penetration",
  customer_or_channel: "customers merchants sellers buyers channel adoption",
  supplier_or_partner: "partners suppliers agreement logistics payments",
  regulatory_or_government: "regulation license regulator central bank rules compliance",
  macro_dataset: "inflation interest rate currency exchange gdp unemployment",
  market_data: "price market capitalization shares volume valuation",
};

/**
 * Headline operating KPIs per business archetype (`src/lib/research/archetypes/registry.ts`): the figures an analyst
 * expects filings and earnings material to report. Evidence extraction searches for them and asks the source reader
 * to extract each one it finds. A run without a listed archetype uses the operating-company list.
 */
export const HEADLINE_KPIS: Record<string, string[]> = {
  operating_company_core: ["revenue by segment", "customers or users", "units or volume", "price or revenue per unit", "employees"],
  advertising_platform: ["daily active users or people (DAU, DAP)", "monthly active users or people (MAU, MAP)", "average revenue per user or person (ARPU, ARPP)", "ad impressions", "average price per ad", "advertisers"],
  marketplace: ["gross merchandise volume (GMV)", "active buyers", "active sellers", "orders", "take rate"],
  payments_network: ["total payment volume (TPV)", "payment transactions", "active accounts", "take rate", "transaction margin"],
  lender: ["loan originations", "loans receivable", "net interest margin (NIM)", "provision for credit losses", "net charge-off rate", "delinquency rate"],
  bank: ["net interest margin (NIM)", "net interest income", "deposits", "loans", "provision for credit losses", "net charge-offs", "CET1 capital ratio", "efficiency ratio"],
  logistics_network: ["shipment or package volume", "revenue per shipment", "network capacity utilization", "on-time delivery"],
  subscription_software: ["annual recurring revenue (ARR)", "net revenue retention", "customers", "remaining performance obligations (RPO)", "subscribers"],
  consumer_brand: ["comparable sales", "units sold", "average selling price", "store count", "gross margin"],
  industrial_hardware: ["backlog", "orders and book-to-bill", "units shipped or delivered", "average selling price", "capacity utilization"],
  commodity_producer: ["production volume", "realized price", "unit cash cost", "all-in sustaining cost", "reserves"],
  holding_company: ["net asset value per share", "look-through earnings", "portfolio company values"],
  etf_fund: ["assets under management", "net flows", "expense ratio", "tracking difference"],
  emerging_market_multi_country: ["revenue by country", "local-currency growth", "foreign-exchange impact"],
};

/** The run's headline KPIs: the union over its archetypes, in table order. */
export function headlineKpis(archetypeKeys: string[]): string[] {
  const lists = archetypeKeys.map(key => HEADLINE_KPIS[key]).filter((list): list is string[] => Boolean(list));
  return [...new Set((lists.length ? lists : [HEADLINE_KPIS.operating_company_core]).flat())];
}

/** Roles whose documents report operating KPIs: filings and earnings material. */
const KPI_SOURCE_ROLES = ["regulatory_filing", "earnings_release", "earnings_exhibit", "earnings_presentation", "earnings_transcript", "company_investor_relations"];

/** Passages the evidence packet draws on. It grows with the corpus, so a 25-filing run reads more than a 3-document one. */
export function evidencePassageBudget(documentCount: number, env: Record<string, string | undefined> = process.env): number {
  const perDocument = Number(env.RESEARCH_EVIDENCE_PASSAGES_PER_SOURCE || 4);
  const max = Number(env.RESEARCH_EVIDENCE_PASSAGES_MAX || 128);
  return Math.max(32, Math.min(max, Math.round(documentCount * perDocument)));
}

/**
 * One need per role present in the run, sharing a packet of `passageBudget` passages (default 32). Founder needs come
 * first so their passages keep the founder tag when a role need would also match them. The headline-KPI need comes
 * next and takes a quarter of the budget when filings or earnings material are present.
 */
export function evidenceNeeds(roles: string[], asset: { name: string }, options: { passageBudget?: number; kpis?: string[] } = {}): RetrievalNeed[] {
  const unique = [...new Set(roles.filter(Boolean))];
  const budget = options.passageBudget || 32;
  const kpiRoles = unique.filter(role => KPI_SOURCE_ROLES.includes(role));
  const kpi: RetrievalNeed[] = options.kpis?.length && kpiRoles.length
    ? [{ key: "headline_kpis", query: options.kpis.join(" "), sourceRoles: kpiRoles, maxPassages: Math.max(6, Math.floor(budget / 4)) }]
    : [];
  const share = Math.max(3, Math.floor((budget - (kpi[0]?.maxPassages || 0)) / Math.max(1, unique.length)));
  const founder = [
    ...(unique.includes("founder_and_company_history") ? [FOUNDER_ORIGIN_NEED] : []),
    ...(unique.some(role => FOUNDER_FILINGS_NEED.sourceRoles!.includes(role)) ? [FOUNDER_FILINGS_NEED] : []),
  ];
  const byRole = unique.filter(role => role !== "founder_and_company_history")
    .map(role => ({ key: `role:${role}`, query: ROLE_QUERIES[role] || `${asset.name} business revenue growth risk`, sourceRoles: [role], maxPassages: share }));
  return [...founder, ...kpi, ...byRole];
}
