/**
 * End-demand backdrop by home country (RQ-SRC-9, RQ-BIZ-8): a few keyless public series, FRED for the US and the
 * World Bank for other countries (plus the CNY rate for China), reduced to latest value, year-on-year change and a
 * five-year history. Forecasts check growth against it instead of assuming a demand boom. Values are untrusted
 * text: only dated numeric rows on or before the cutoff are read.
 */
import { fetchCapped } from "@/lib/net";

const AGENT = "ResearchOS/0.1 research-pipeline@example.com";
export type DemandSeries = { id: string; label: string; source: "fred" | "world_bank"; unit: string; frequency: "monthly" | "quarterly" | "annual" | "daily" };

const US: DemandSeries[] = [
  { id: "RSAFS", label: "US retail and food services sales", source: "fred", unit: "USD millions", frequency: "monthly" },
  { id: "PCE", label: "US personal consumption expenditures", source: "fred", unit: "USD billions, SAAR", frequency: "monthly" },
  { id: "ECOMSA", label: "US e-commerce retail sales", source: "fred", unit: "USD millions", frequency: "quarterly" },
  { id: "CPIAUCSL", label: "US consumer price index", source: "fred", unit: "index 1982-84=100", frequency: "monthly" },
];
const WORLD_BANK: Omit<DemandSeries, "id">[] = [
  { label: "Household consumption growth", source: "world_bank", unit: "% real", frequency: "annual" },
  { label: "Consumer price inflation", source: "world_bank", unit: "%", frequency: "annual" },
  { label: "Real GDP growth", source: "world_bank", unit: "%", frequency: "annual" },
];
const WORLD_BANK_IDS = ["NE.CON.PRVT.KD.ZG", "FP.CPI.TOTL.ZG", "NY.GDP.MKTP.KD.ZG"];

const COUNTRIES: Record<string, string> = {
  "us": "US", "usa": "US", "united states": "US", "united states of america": "US", "china": "CN", "cn": "CN", "prc": "CN",
  "people's republic of china": "CN", "hong kong": "HK", "uruguay": "UY", "argentina": "AR", "brazil": "BR", "mexico": "MX",
  "netherlands": "NL", "italy": "IT", "united kingdom": "GB", "uk": "GB", "germany": "DE", "france": "FR", "japan": "JP",
  "india": "IN", "canada": "CA", "cayman islands": "KY", "ireland": "IE", "switzerland": "CH", "taiwan": "TW", "south korea": "KR",
};
/** ISO alpha-2 from the stored home_country, which mixes codes and names ("US", "United States", "Uruguay"). */
export function normalizeCountry(value: string | null | undefined): string | null {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return null;
  if (COUNTRIES[key]) return COUNTRIES[key];
  return /^[a-z]{2}$/.test(key) ? key.toUpperCase() : null;
}

export function demandSeriesFor(country: string | null): DemandSeries[] {
  if (country === "US") return US;
  if (!country) return [];
  const worldBank = WORLD_BANK.map((s, i) => ({ ...s, id: `${country}:${WORLD_BANK_IDS[i]}`, label: `${country} ${s.label.toLowerCase()}` }));
  return country === "CN" ? [...worldBank, { id: "DEXCHUS", label: "CNY per USD", source: "fred", unit: "CNY per USD", frequency: "daily" }] : worldBank;
}

type Point = { date: string; value: number };
/** FRED graph CSV: "observation_date,ID" then dated rows; "." marks a holiday. */
export function parseFredCsv(csv: string, cutoff: string): Point[] {
  return csv.split(/\r?\n/).slice(1).map((line) => line.split(","))
    .filter(([date, value]) => /^\d{4}-\d{2}-\d{2}$/.test(date || "") && date <= cutoff && value && value !== "." && Number.isFinite(Number(value)))
    .map(([date, value]) => ({ date, value: Number(value) }));
}
/** World Bank v2 JSON: [meta, [{date: "2024", value}]], newest first. */
export function parseWorldBank(json: unknown, cutoff: string): Point[] {
  const rows = Array.isArray(json) && Array.isArray(json[1]) ? json[1] as { date?: unknown; value?: unknown }[] : [];
  return rows.filter((r) => /^\d{4}$/.test(String(r.date)) && typeof r.value === "number" && Number.isFinite(r.value) && `${r.date}-12-31` <= cutoff)
    .map((r) => ({ date: `${r.date}-12-31`, value: r.value as number })).sort((a, b) => a.date.localeCompare(b.date));
}

const round = (v: number | null) => v === null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
/** Latest value, change against the same date a year earlier (level series) and annual points for five years. */
export function summarizeSeries(series: DemandSeries, points: Point[]) {
  if (!points.length) return null;
  const latest = points.at(-1)!;
  const yearAgoDate = `${Number(latest.date.slice(0, 4)) - 1}${latest.date.slice(4)}`;
  const yearAgo = [...points].reverse().find((p) => p.date <= yearAgoDate);
  const isRate = series.unit.startsWith("%");
  const byYear = new Map<string, Point>();
  for (const p of points) byYear.set(p.date.slice(0, 4), p);
  return { ...series, latest, yoy_change: isRate || !yearAgo ? null : round(latest.value / yearAgo.value - 1),
    history: [...byYear.values()].slice(-5).map((p) => ({ year: p.date.slice(0, 4), value: round(p.value) })) };
}

export async function buildDemandBackdrop(homeCountry: string | null | undefined, cutoff: string, fetchImpl: typeof fetchCapped = fetchCapped) {
  const country = normalizeCountry(homeCountry);
  const series = demandSeriesFor(country);
  const out = [], gaps: { id: string; reason: string }[] = [];
  for (const s of series) {
    try {
      const url = s.source === "fred" ? `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.id}`
        : `https://api.worldbank.org/v2/country/${s.id.split(":")[0]}/indicator/${s.id.split(":")[1]}?format=json&per_page=60`;
      const response = await fetchImpl(url, { headers: { "User-Agent": AGENT } }, { timeoutMs: 20_000, maxBytes: 4_000_000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const points = s.source === "fred" ? parseFredCsv(await response.text(), cutoff) : parseWorldBank(await response.json(), cutoff);
      const summary = summarizeSeries(s, points);
      if (summary) out.push({ ...summary, url }); else gaps.push({ id: s.id, reason: "No observation on or before the cutoff." });
    } catch (error) {
      gaps.push({ id: s.id, reason: `Unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
    }
  }
  return { artifact_type: "demand_backdrop", country, home_country: homeCountry ?? null, cutoff, series: out, gaps,
    status: out.length ? "complete" : country ? "unavailable" : "no_country",
    note: "Macro demand context for the home country. It bounds what end demand can contribute to growth; the company's own end markets may differ by segment and geography." };
}
