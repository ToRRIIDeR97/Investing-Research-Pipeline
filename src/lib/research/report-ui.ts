export const RESEARCH_TABS = [
  { slug: "general", label: "General", description: "The complete research memo and decision context." },
  { slug: "financials", label: "Financials & KPIs", description: "Historical observations and operating signals." },
  { slug: "valuation", label: "Valuation", description: "Scenarios, targets, and expected returns." },
  { slug: "thesis", label: "Thesis & Risks", description: "Drivers, risks, catalysts, and breakers." },
  { slug: "evidence", label: "Evidence", description: "Claims, source roles, and provenance." },
  { slug: "backtests", label: "Backtests", description: "Timing evidence and confidence checks." },
  { slug: "updates", label: "Updates", description: "Run history, monitoring, and open work." },
] as const;

export type ResearchTabSlug = (typeof RESEARCH_TABS)[number]["slug"];

export const CANONICAL_REPORT_SECTIONS = [
  [1, "Executive conclusion"],
  [2, "Company genesis and strategic identity"],
  [3, "Asset definition"],
  [4, "Evidence and source-role map"],
  [5, "Twenty-quarter historical record"],
  [6, "Historical diagnosis"],
  [7, "Segment and value-chain map"],
  [8, "Customer decision processes"],
  [9, "Operational process and bottlenecks"],
  [10, "Competitive response"],
  [11, "Moat proof, attacks, and no-moat counterfactual"],
  [12, "Driver tree and operating model"],
  [13, "Top-down/bottom-up reconciliation"],
  [14, "Reinvestment economics"],
  [15, "Operating scenarios"],
  [16, "Valuation scenario matrix"],
  [17, "Annual bear/base/bull price-target table"],
  [18, "Reverse valuation"],
  [19, "Expected-return matrix"],
  [20, "Risks and catalysts"],
  [21, "Thesis breakers"],
  [22, "Monitoring dashboard"],
  [23, "Backtesting evidence and confidence assessment"],
  [24, "Human decision"],
  [25, "Limitations and open research"],
] as const;

export type CanonicalReportSection = (typeof CANONICAL_REPORT_SECTIONS)[number];

const TAB_BY_HEADING: Record<number, ResearchTabSlug> = {
  1: "general",
  2: "general",
  3: "general",
  4: "evidence",
  5: "financials",
  6: "financials",
  7: "general",
  8: "general",
  9: "general",
  10: "general",
  11: "general",
  12: "financials",
  13: "financials",
  14: "financials",
  15: "financials",
  16: "valuation",
  17: "valuation",
  18: "valuation",
  19: "valuation",
  20: "thesis",
  21: "thesis",
  22: "updates",
  23: "backtests",
  24: "thesis",
  25: "updates",
};

export function tabForCanonicalHeading(number: number): ResearchTabSlug {
  return TAB_BY_HEADING[number] ?? "general";
}

export function canonicalHeadingNumber(value: string): number | null {
  const match = value.trim().match(/^(?:#{1,6}\s*)?(\d+)\s*[.)]\s+/);
  if (!match) return null;
  const number = Number(match[1]);
  return CANONICAL_REPORT_SECTIONS.some(([sectionNumber]) => sectionNumber === number)
    ? number
    : null;
}

export function canonicalHeadingAnchor(number: number) {
  return `report-section-${number}`;
}

export function tabPath(assetId: string, tab: ResearchTabSlug, runId?: string | null) {
  const path = `/assets/${encodeURIComponent(assetId)}/research/${tab}`;
  if (!runId) return path;
  return `${path}?run=${encodeURIComponent(runId)}`;
}

/** Markdown links are rendered as plain text unless they stay within the workspace or use HTTP(S). */
export function safeMarkdownHref(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const href = value.trim();
  if ((href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#") || href.startsWith("?")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

export interface FinancialMetricMatrixRow {
  key: string;
  label: string;
  unit: string | null;
  currency: string | null;
  values: Record<string, unknown>;
}

export function buildFinancialMetricMatrix(observations: Array<Record<string, unknown>>) {
  const periods = new Set<string>();
  const metrics = new Map<string, FinancialMetricMatrixRow>();
  for (const observation of observations) {
    const key = String(observation.metric_key ?? "").trim();
    const rawPeriod = observation.period_end ?? observation.as_of_date;
    if (!key || !rawPeriod) continue;
    const date = new Date(String(rawPeriod));
    const period = Number.isNaN(date.getTime()) ? String(rawPeriod) : date.toISOString().slice(0, 10);
    periods.add(period);
    const row = metrics.get(key) ?? {
      key,
      label: String(observation.metric_display_name ?? key).replace(/_/g, " "),
      unit: observation.unit ? String(observation.unit) : null,
      currency: observation.currency ? String(observation.currency) : null,
      values: {},
    };
    if (!(period in row.values)) row.values[period] = observation.value_numeric ?? observation.value_text ?? null;
    metrics.set(key, row);
  }
  return {
    periods: [...periods].sort((left, right) => right.localeCompare(left)),
    metrics: [...metrics.values()],
  };
}
