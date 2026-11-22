// The key numbers an asset's pages and cards lead with: price, the per-share value of each case, the gap between
// them, the yearly targets and the monitored KPIs with a good/bad tone. Read from a run's code-computed artifacts
// (report_facts first, then valuation_scenario_set), never re-derived, so every screen shows the report's numbers.

export type CaseType = "bear" | "base" | "bull";
export type KpiTone = "good" | "bad" | "neutral";
export interface SnapshotKpi {
  label: string;
  value: number;
  unit: string | null;
  display: string;
  tone: KpiTone;
  bear_threshold: number | null;
  bull_threshold: number | null;
  base_range: string | null;
}
export interface AssetSnapshot {
  currency: string;
  price: number | null;
  price_verified: boolean;
  values: Record<CaseType, number | null>;
  weighted: number | null;
  gap: Record<CaseType, number | null>;
  probabilities: Record<CaseType, number | null>;
  targets: { year: number; bear: number | null; base: number | null; bull: number | null }[];
  kpis: SnapshotKpi[];
}

type Row = Record<string, any>;
const CASES: CaseType[] = ["bear", "base", "bull"];
const MAX_KPIS = 6;

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const content = (artifacts: Row[], type: string): Row | null => {
  const artifact = artifacts.find((a) => (a?.type ?? a?.artifact_type) === type);
  const body = artifact?.content_json;
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
};

/** A KPI level as short text: percentages to two places, large counts as k, m or bn. */
export function formatKpi(value: number, unit: string | null): string {
  const u = (unit ?? "").toLowerCase();
  const trim = (n: number, places: number) => String(Number(n.toFixed(places)));
  if (u.includes("percent") || u === "%" || u === "pct") return `${trim(value, 2)}%`;
  if (u === "ratio" || u === "x" || u.includes("multiple")) return `${trim(value, 2)}x`;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return trim(value, 2);
}

function kpiTone(value: number, bear: number | null, bull: number | null): KpiTone {
  if (bear == null || bull == null || bear === bull) return "neutral";
  const higherBetter = bull > bear;
  if (higherBetter ? value >= bull : value <= bull) return "good";
  if (higherBetter ? value <= bear : value >= bear) return "bad";
  return "neutral";
}

export function assetSnapshot(artifacts: Row[]): AssetSnapshot | null {
  const facts = content(artifacts, "report_facts");
  const valuation = content(artifacts, "valuation_scenario_set");
  const path = content(artifacts, "annual_price_target_path");
  if (!facts && !valuation) return null;

  const price = num(facts?.market_price) ?? num(valuation?.current_market_price);
  const withheld = facts?.valuation_status != null && facts.valuation_status !== "complete";
  const values: Record<CaseType, number | null> = { bear: null, base: null, bull: null };
  const probabilities: Record<CaseType, number | null> = { bear: null, base: null, bull: null };
  let weighted: number | null = null;
  if (!withheld) {
    const columns: unknown[] = Array.isArray(facts?.cases?.columns) ? facts!.cases.columns : [];
    const rows: unknown[][] = Array.isArray(facts?.cases?.rows) ? facts!.cases.rows : [];
    const at = (name: string) => columns.indexOf(name);
    const [caseAt, pvAt, probabilityAt] = [at("case"), at("pv_per_share"), at("probability")];
    if (facts && caseAt >= 0) {
      for (const row of rows) {
        const type = String(row?.[caseAt] ?? "") as CaseType;
        if (!CASES.includes(type)) continue;
        if (pvAt >= 0) values[type] = num(row[pvAt]);
        if (probabilityAt >= 0) probabilities[type] = num(row[probabilityAt]);
      }
      weighted = num(facts.weighted?.pv_per_share);
    } else if (!facts && valuation) {
      for (const type of CASES) {
        values[type] = num(valuation[`value_today_${type}`]) ?? num(valuation[`terminal_anchor_${type}`]);
        probabilities[type] = num(valuation[`probability_${type}`]);
      }
      weighted = num(valuation.weighted_target);
    }
  }
  const gap = Object.fromEntries(CASES.map((t) => [t, values[t] != null && price ? values[t]! / price - 1 : null])) as Record<CaseType, number | null>;

  const byYear = new Map<number, { year: number; bear: number | null; base: number | null; bull: number | null }>();
  for (const row of Array.isArray(path?.price_target_path) ? path!.price_target_path as Row[] : []) {
    const year = num(row?.fiscal_year);
    const type = String(row?.scenario_type ?? "") as CaseType;
    if (year == null || !CASES.includes(type)) continue;
    const entry = byYear.get(year) ?? { year, bear: null, base: null, bull: null };
    entry[type] = num(row.price_target);
    byYear.set(year, entry);
  }

  const items: Row[] = Array.isArray(content(artifacts, "monitoring_dashboard")?.items) ? content(artifacts, "monitoring_dashboard")!.items : [];
  const kpis: SnapshotKpi[] = items.flatMap((item) => {
    const value = num(item?.current_level);
    const label = typeof item?.kpi === "string" ? item.kpi.trim() : "";
    if (value == null || !label) return [];
    const bear = num(item.bear_threshold), bull = num(item.bull_threshold);
    const unit = typeof item.unit === "string" ? item.unit : null;
    return [{ label, value, unit, display: formatKpi(value, unit), tone: kpiTone(value, bear, bull), bear_threshold: bear, bull_threshold: bull,
      base_range: typeof item.base_range === "string" ? item.base_range : null }];
  }).slice(0, MAX_KPIS);

  return {
    currency: String(facts?.currency ?? path?.currency ?? "USD"),
    price,
    price_verified: valuation?.current_market_price_source?.verified === true,
    values, weighted, gap, probabilities,
    targets: [...byYear.values()].sort((a, b) => a.year - b.year),
    kpis,
  };
}
