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
 * One need per role present in the run, sharing a packet of about 32 passages. Founder needs come
 * first so their passages keep the founder tag when a role need would also match them.
 */
export function evidenceNeeds(roles: string[], asset: { name: string }): RetrievalNeed[] {
  const unique = [...new Set(roles.filter(Boolean))];
  const share = Math.max(3, Math.floor(32 / Math.max(1, unique.length)));
  const founder = [
    ...(unique.includes("founder_and_company_history") ? [FOUNDER_ORIGIN_NEED] : []),
    ...(unique.some(role => FOUNDER_FILINGS_NEED.sourceRoles!.includes(role)) ? [FOUNDER_FILINGS_NEED] : []),
  ];
  const byRole = unique.filter(role => role !== "founder_and_company_history")
    .map(role => ({ key: `role:${role}`, query: ROLE_QUERIES[role] || `${asset.name} business revenue growth risk`, sourceRoles: [role], maxPassages: share }));
  return [...founder, ...byRole];
}
