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
 * to extract each one it finds. Each entry is the KPI's name followed by the phrases filings use for it, separated by
 * " | "; retrieval matches those phrases whole, so generic words such as "revenue" or "price" never match on their own.
 */
export const HEADLINE_KPIS: Record<string, string[]> = {
  operating_company_core: ["segment revenue | revenue by segment", "paying customers | active customers | number of customers", "units shipped | unit volume", "average selling price | ASP", "employees | headcount"],
  advertising_platform: ["daily active people | DAP | daily active users | DAU", "monthly active people | monthly active users | MAU", "average revenue per person | ARPP | average revenue per user | ARPU", "ad impressions", "average price per ad", "active advertisers | number of advertisers"],
  marketplace: ["gross merchandise volume | GMV | gross merchandise value", "active buyers", "active sellers", "orders placed | number of orders", "take rate"],
  payments_network: ["total payment volume | TPV", "payment transactions | transactions processed", "active accounts", "take rate", "transaction margin"],
  lender: ["loan originations | originations", "loans receivable", "net interest margin | NIM", "provision for credit losses", "net charge-off rate | net charge-offs", "delinquency rate | delinquencies"],
  bank: ["net interest margin | NIM", "net interest income", "total deposits", "total loans | loans held for investment", "provision for credit losses", "net charge-offs", "CET1 capital ratio | common equity tier 1", "efficiency ratio"],
  logistics_network: ["shipment volume | package volume | average daily volume", "revenue per shipment | revenue per piece", "network capacity utilization | load factor", "on-time delivery"],
  subscription_software: ["annual recurring revenue | ARR", "net revenue retention | net dollar retention", "paying customers | customers with ARR", "remaining performance obligations | RPO", "paid subscribers"],
  consumer_brand: ["comparable sales | same-store sales", "units sold", "average selling price", "store count | number of stores", "gross margin"],
  industrial_hardware: ["backlog", "book-to-bill | new orders", "units shipped | deliveries", "average selling price", "capacity utilization"],
  commodity_producer: ["production volume | production", "realized price | average realized price", "unit cash cost | cash cost per", "all-in sustaining cost | AISC", "proved reserves | reserves"],
  holding_company: ["net asset value per share | NAV per share", "look-through earnings", "portfolio company values | gross asset value"],
  etf_fund: ["assets under management | AUM", "net flows | net inflows", "expense ratio", "tracking difference | tracking error"],
  emerging_market_multi_country: ["revenue by country", "local currency growth | constant currency", "foreign exchange impact | FX impact"],
};

/** The run's headline KPIs: the union over its archetypes, in table order. */
export function headlineKpis(archetypeKeys: string[]): string[] {
  const lists = archetypeKeys.map(key => HEADLINE_KPIS[key]).filter((list): list is string[] => Boolean(list));
  return [...new Set((lists.length ? lists : [HEADLINE_KPIS.operating_company_core]).flat())];
}

/** The phrases a list of headline KPIs searches for. */
export const kpiPhrases = (kpis: string[]) => [...new Set(kpis.flatMap(kpi => kpi.split("|").map(term => term.trim()).filter(Boolean)))];

/**
 * The asset's own classification, mapped to headline-KPI archetypes. Used for KPI selection only: the v3 archetype
 * composition is unchanged. SIC ranges are inclusive; text matches the stored sector, industry and SIC description.
 * A rule with `unless` doesn't apply when the text also matches it.
 */
const KPI_CLASSIFICATION_RULES: { archetype: string; sic?: [number, number][]; text?: RegExp; unless?: RegExp }[] = [
  // SIC 7370 also covers IT services and travel sites, so an ad platform needs ad, social or internet-content wording.
  { archetype: "advertising_platform", sic: [[7311, 7319]], text: /interactive media|internet content|social media|advertising|search engine/i },
  { archetype: "subscription_software", sic: [[7372, 7372]], text: /software|saas/i },
  { archetype: "bank", sic: [[6020, 6036]], text: /\bbank/i },
  { archetype: "lender", sic: [[6140, 6163]], text: /consumer finance|lending|mortgage/i },
  // "Credit Services" alone covers card networks and card lenders, so it gives both lists; payment wording makes it payments only.
  { archetype: "lender", text: /credit services/i, unless: /payment|card network|transaction processing|\bvisa\b|mastercard|american express/i },
  { archetype: "payments_network", text: /payment|transaction processing|card network|credit services/i },
  { archetype: "marketplace", sic: [[5961, 5961]], text: /internet retail|marketplace|e-?commerce/i },
  { archetype: "logistics_network", sic: [[4210, 4231], [4510, 4731]], text: /trucking|freight|logistics|delivery|airlines|railroads|integrated shipping/i },
  { archetype: "commodity_producer", sic: [[1000, 1499], [2911, 2911]], text: /\boil\b|\bgas\b|mining|metals|gold|copper|coal|uranium/i, unless: /utilit|regulated|distribution/i },
  // SIC 3570-3579 (computers and office equipment) report no backlog or book-to-bill.
  { archetype: "industrial_hardware", sic: [[3500, 3569], [3580, 3599], [3700, 3799]], text: /machinery|aerospace|semiconductor equipment|electrical equipment|industrial (?:products|equipment|distribution)/i },
  { archetype: "consumer_brand", sic: [[2000, 2399], [5810, 5813]], text: /apparel|footwear|beverages|packaged foods|household|restaurants|consumer electronics|luxury/i },
  { archetype: "holding_company", sic: [[6719, 6719]], text: /holding company|conglomerate/i },
];

/**
 * Archetypes whose headline KPIs a run searches for: its composed archetypes plus those its classification maps to.
 * The generic operating-company list is used only when nothing more specific applies, so its broad terms never
 * crowd out a specific list, or when a specific archetype rests on the SIC code alone without confirming text.
 */
export function kpiArchetypes(archetypeKeys: string[], classification: { sector?: string | null; industry?: string | null; sic?: string | number | null; sicDescription?: string | null; assetKind?: string | null }): string[] {
  const sic = Number(classification.sic);
  const text = [classification.sector, classification.industry, classification.sicDescription].filter(Boolean).join(" ");
  const byText = new Set<string>();
  const bySic = new Set<string>();
  for (const rule of KPI_CLASSIFICATION_RULES) {
    if (rule.unless?.test(text)) continue;
    if (text && rule.text?.test(text)) byText.add(rule.archetype);
    else if (Number.isFinite(sic) && sic > 0 && rule.sic?.some(([low, high]) => sic >= low && sic <= high)) bySic.add(rule.archetype);
  }
  if (classification.assetKind === "fund") byText.add("etf_fund");
  const composed = archetypeKeys.filter(key => key !== "operating_company_core" && HEADLINE_KPIS[key]);
  const specific = [...new Set([...composed, ...byText, ...bySic])];
  const sicOnly = [...bySic].some(key => !byText.has(key) && !composed.includes(key));
  return specific.length && !sicOnly ? specific : [...specific, "operating_company_core"];
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
    ? [{ key: "headline_kpis", query: kpiPhrases(options.kpis).join(" "), phrases: kpiPhrases(options.kpis), sourceRoles: kpiRoles, maxPassages: Math.max(6, Math.floor(budget / 4)) }]
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
