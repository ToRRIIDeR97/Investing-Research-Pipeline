/**
 * Theme research v1 (Implementations/research-workspace P4), after the method in Nanalyze's "How to Invest in the
 * Future of …" videos: a durable demand driver, picks-and-shovels candidates triangulated from independent sources and
 * counted for agreement, exclusions with reasons, a fundamentals scorecard computed from SEC companyfacts, a ranking by
 * the operator's objectives and a shortlist of four. These are the pure parts; `pipeline.ts` makes the model calls and
 * SEC fetches.
 */
import { z } from "zod";

export const ROLES = ["supplier", "operator", "other"] as const;
export type Role = typeof ROLES[number];

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
const line = (min: number, max: number) => z.string().transform((s) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim()).pipe(z.string().min(min).max(max));
const weight = z.number().finite().min(0).max(1);
export const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

export const ThemeRequest = z.object({
  theme: line(3, 200),
  horizon_years: z.number().int().min(3).max(30),
  roles: z.array(z.enum(ROLES)).min(1).max(3).refine((r) => new Set(r).size === r.length, "Each role once"),
  min_exposure: z.number().finite().min(0).max(1),
  us_only: z.boolean(),
  objectives: z.object({ growth: weight, quality: weight, value: weight, balance_sheet: weight }).strict()
    .refine((o) => o.growth + o.quality + o.value + o.balance_sheet > 0, "Give at least one objective some weight"),
  tickers: z.array(z.string().transform((t) => t.trim().toUpperCase()).pipe(z.string().regex(TICKER, "Not a ticker"))).max(100).optional(),
}).strict();
export type ThemeRequest = z.infer<typeof ThemeRequest>;
export type Objectives = ThemeRequest["objectives"];

const normal = (ticker: string) => ticker.trim().toUpperCase();

/** How many independent sources name each ticker (once per source), most agreed first, then by ticker. */
export function countAgreement(sources: { source: string; tickers: string[] }[]): { ticker: string; sources: string[]; count: number }[] {
  const named = new Map<string, string[]>();
  for (const { source, tickers } of sources) {
    for (const ticker of new Set(tickers.map(normal).filter(Boolean))) {
      const list = named.get(ticker) ?? [];
      if (!list.includes(source)) list.push(source);
      named.set(ticker, list);
    }
  }
  return [...named.entries()].map(([ticker, list]) => ({ ticker, sources: list, count: list.length }))
    .sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker));
}

export type SecTicker = { ticker: string; title: string; cik_str: number };
/** Tickers checked against SEC's company_tickers.json: the registrant's name and a 10-digit CIK, or unknown. */
export function validateTickers(tickers: string[], sec: Record<string, SecTicker>) {
  const byTicker = new Map<string, SecTicker>();
  for (const entry of Object.values(sec)) if (entry && typeof entry.ticker === "string" && Number.isFinite(Number(entry.cik_str))) byTicker.set(normal(entry.ticker), entry);
  const valid: { ticker: string; title: string; cik: string }[] = [], unknown: string[] = [];
  for (const ticker of [...new Set(tickers.map(normal).filter(Boolean))]) {
    const entry = byTicker.get(ticker);
    if (entry) valid.push({ ticker, title: String(entry.title ?? ""), cik: String(Math.trunc(Number(entry.cik_str))).padStart(10, "0") });
    else unknown.push(ticker);
  }
  return { valid, unknown };
}

const roleText: Record<Role, string> = { supplier: "a supplier (picks and shovels)", operator: "an operator of the theme's assets", other: "neither a supplier nor an operator" };

/**
 * Exclusions with reader-facing reasons: a role the operator did not ask for, exposure below the minimum, or no US
 * listing when only US listings are wanted. An unknown exposure is kept and flagged.
 */
export function excludeCandidates<T extends { ticker: string; role: Role; exposure: number | null; us_listed: boolean }>(candidates: T[],
  prefs: Pick<ThemeRequest, "roles" | "min_exposure" | "us_only">): { kept: (T & { flags: string[] })[]; excluded: { ticker: string; reason: string }[] } {
  const kept: (T & { flags: string[] })[] = [], excluded: { ticker: string; reason: string }[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  for (const c of candidates) {
    if (!prefs.roles.includes(c.role)) excluded.push({ ticker: c.ticker, reason: `It is ${roleText[c.role]}, a role you did not ask for.` });
    else if (c.exposure !== null && c.exposure < prefs.min_exposure)
      excluded.push({ ticker: c.ticker, reason: `About ${pct(c.exposure)} of its business is exposed to the theme, below your minimum of ${pct(prefs.min_exposure)}.` });
    else if (prefs.us_only && !c.us_listed) excluded.push({ ticker: c.ticker, reason: "It has no US listing, and you asked for US-listed stocks only." });
    else kept.push({ ...c, flags: c.exposure === null ? ["exposure unknown"] : [] });
  }
  return { kept, excluded };
}

type Fact = { start?: string; end?: string; val?: unknown; fy?: unknown; fp?: unknown; form?: unknown; filed?: string };
type Facts = { facts?: Record<string, Record<string, { units?: Record<string, Fact[]> }>> };
const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;

/** A concept's 10-K fiscal-year values by period end, the latest filing for each end. */
function annual(companyFacts: Facts, concept: string, unit = "USD", duration = true): Map<string, number> {
  const facts = companyFacts?.facts?.["us-gaap"]?.[concept]?.units?.[unit];
  const best = new Map<string, { filed: string; val: number }>();
  if (!Array.isArray(facts)) return new Map();
  for (const f of facts) {
    if (f?.form !== "10-K" || f?.fp !== "FY" || typeof f.end !== "string" || typeof f.val !== "number" || !Number.isFinite(f.val)) continue;
    if (duration) { if (typeof f.start !== "string") continue; const span = days(f.start, f.end); if (!(span >= 330 && span <= 400)) continue; }
    else if (typeof f.start === "string") continue;
    const filed = typeof f.filed === "string" ? f.filed : "";
    const held = best.get(f.end);
    if (!held || filed > held.filed) best.set(f.end, { filed, val: f.val });
  }
  return new Map([...best.entries()].map(([end, v]) => [end, v.val]));
}
const firstWithData = (companyFacts: Facts, concepts: string[], unit = "USD", duration = true) => {
  for (const c of concepts) { const m = annual(companyFacts, c, unit, duration); if (m.size) return m; }
  return new Map<string, number>();
};
/** The value whose period ends about `years` before `end` (within 45 days). */
function yearsBefore(series: Map<string, number>, end: string, years: number): number | null {
  const target = Date.parse(end) - years * 365.25 * DAY;
  let best: { gap: number; val: number } | null = null;
  for (const [e, val] of series) { const gap = Math.abs(Date.parse(e) - target) / DAY; if (gap <= 45 && (!best || gap < best.gap)) best = { gap, val }; }
  return best ? best.val : null;
}
const latestEnd = (series: Map<string, number>) => [...series.keys()].sort().at(-1) ?? null;

export type ScorecardRow = { fiscal_year_end: string | null; revenue: number | null; revenue_growth_1y: number | null; revenue_cagr_5y: number | null;
  operating_margin: number | null; net_debt: number | null; fcf: number | null; payback_years: number | null; pe_ttm: number | null };

/**
 * A fundamentals row from SEC companyfacts (10-K, fiscal-year facts of 330-400 days, the latest filing per period end),
 * at the latest fiscal year with revenue. Missing inputs give null, never 0.
 */
export function scorecardRow(companyFacts: unknown, price: number | null): ScorecardRow {
  const cf = (companyFacts ?? {}) as Facts;
  const revenue = firstWithData(cf, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"]);
  const end = latestEnd(revenue);
  const at = (series: Map<string, number>) => end && series.has(end) ? series.get(end)! : null;
  const rev = end ? revenue.get(end)! : null;
  const prior = end ? yearsBefore(revenue, end, 1) : null, five = end ? yearsBefore(revenue, end, 5) : null;
  const opIncome = at(annual(cf, "OperatingIncomeLoss"));
  const ocf = at(annual(cf, "NetCashProvidedByUsedInOperatingActivities")), capex = at(annual(cf, "PaymentsToAcquirePropertyPlantAndEquipment"));
  const instant = (concepts: string[]) => at(firstWithData(cf, concepts, "USD", false));
  const debt = instant(["LongTermDebt", "LongTermDebtNoncurrent"]), short = instant(["ShortTermBorrowings"]);
  const cash = instant(["CashAndCashEquivalentsAtCarryingValue"]), securities = instant(["MarketableSecuritiesCurrent"]);
  const parts = [debt, short, cash, securities];
  const netDebt = parts.every((p) => p === null) ? null : (debt ?? 0) + (short ?? 0) - (cash ?? 0) - (securities ?? 0);
  const fcf = ocf !== null && capex !== null ? ocf - capex : null;
  const eps = firstWithData(cf, ["EarningsPerShareDiluted"], "USD/shares");
  const epsEnd = latestEnd(eps), latestEps = epsEnd ? eps.get(epsEnd)! : null;
  return {
    fiscal_year_end: end,
    revenue: rev,
    revenue_growth_1y: rev !== null && prior ? rev / prior - 1 : null,
    revenue_cagr_5y: rev !== null && five && five > 0 && rev > 0 ? (rev / five) ** (1 / 5) - 1 : null,
    operating_margin: rev && opIncome !== null ? opIncome / rev : null,
    net_debt: netDebt,
    fcf,
    payback_years: netDebt === null ? null : netDebt <= 0 ? 0 : fcf === null || fcf <= 0 ? null : netDebt / fcf,
    pe_ttm: price !== null && price > 0 && latestEps !== null && latestEps > 0 ? price / latestEps : null,
  };
}

export const FACTORS = ["growth", "quality", "value", "balance_sheet"] as const;
type FactorRow = { ticker: string; growth: number | null; quality: number | null; value: number | null; balance_sheet: number | null };

/** The ranking inputs: growth = 5-year CAGR (else 1-year growth), quality = operating margin, value = earnings yield, balance sheet = −payback years. */
export function rankingInputs(ticker: string, row: ScorecardRow): FactorRow {
  return { ticker, growth: row.revenue_cagr_5y ?? row.revenue_growth_1y, quality: row.operating_margin,
    value: row.pe_ttm ? 1 / row.pe_ttm : null, balance_sheet: row.payback_years === null ? null : -row.payback_years };
}

/** Percentiles within the set: ascending position ÷ (n − 1), ties share their average position, a single value 1, nulls 0. */
function percentiles(values: (number | null)[]): number[] {
  const present = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v !== null && Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  const out = values.map(() => 0);
  if (present.length === 1) { out[present[0].i] = 1; return out; }
  for (let start = 0; start < present.length;) {
    let stop = start;
    while (stop + 1 < present.length && present[stop + 1].v === present[start].v) stop += 1;
    const position = (start + stop) / 2;
    for (let k = start; k <= stop; k++) out[present[k].i] = position / (present.length - 1);
    start = stop + 1;
  }
  return out;
}

/** Each factor as a percentile within the set, weighted by the objectives; score = weighted mean × 100 (one decimal), best first. */
export function rankCandidates<T extends FactorRow>(rows: T[], objectives: Objectives): (T & { score: number; percentiles: Record<typeof FACTORS[number], number> })[] {
  const p = Object.fromEntries(FACTORS.map((f) => [f, percentiles(rows.map((r) => r[f]))])) as Record<typeof FACTORS[number], number[]>;
  const total = FACTORS.reduce((n, f) => n + objectives[f], 0);
  return rows.map((row, i) => {
    const mean = total > 0 ? FACTORS.reduce((n, f) => n + objectives[f] * p[f][i], 0) / total : 0;
    return { ...row, score: Math.round(mean * 1000) / 10, percentiles: Object.fromEntries(FACTORS.map((f) => [f, p[f][i]])) as Record<typeof FACTORS[number], number> };
  }).sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
}

/**
 * The companies EDGAR lists for a SIC code (the browse-edgar company list page): each row's CIK and name. The page is
 * untrusted HTML; only 10-digit CIKs from company links and the plain text of the next cell are read.
 */
export function parseSicCompanies(html: string): { cik: string; name: string }[] {
  const out = new Map<string, string>();
  const row = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const match of html.matchAll(row)) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 2) continue;
    const cik = /CIK=(\d{1,10})/i.exec(cells[0])?.[1];
    if (!cik) continue;
    const name = cells[1].replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    out.set(cik.padStart(10, "0"), name);
  }
  return [...out.entries()].map(([cik, name]) => ({ cik, name }));
}

/** Ownership options for the shortlist, as text: an equal-weight basket, the single leader, or a theme ETF. */
export function ownershipOptions(shortlist: { ticker: string; score: number }[], etfs: string[]) {
  const names = shortlist.map((s) => s.ticker);
  return [
    { kind: "basket", title: "Equal-weight basket", text: names.length ? `Hold ${names.join(", ")} in equal weights (${(100 / names.length).toFixed(0)}% each) and rebalance when one drifts far from its weight; no single company decides the outcome.` : "No shortlist to hold." },
    { kind: "leader", title: "Single leader", text: names.length ? `Hold only ${names[0]}, the highest score on your objectives; simpler, but one company's execution carries the whole bet.` : "No leader." },
    { kind: "etf", title: "A theme ETF", text: etfs.length ? `Hold a fund that tracks the theme, such as ${etfs.slice(0, 3).join(", ")} (named by the model's framing; check holdings, fees and how pure the fund is before buying).` : "Hold a fund that tracks the theme; check its holdings, fees and how pure it is before buying." },
  ];
}
