/**
 * The Quant finder's data: SEC's ticker directory for type-ahead, and the tickers recently computed in
 * `quant_snapshots` with their grades. Read-only; no model calls. SEC's map is untrusted data: entries are kept only
 * when the ticker matches TICKER_PATTERN, and names are trimmed and capped.
 */
import type postgres from "postgres";
import { fetchCapped } from "@/lib/net";
import { TICKER_PATTERN } from "./ticker";

type Sql = ReturnType<typeof postgres>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type DirectoryEntry = { ticker: string; name: string };

/** A computed snapshot as the finder shows it: enough for a result row or a recent card. */
export type FinderSnapshot = {
  ticker: string;
  name: string;
  price: number | null;
  as_of: string | null;
  pulse_grade: string | null;
  pq_grade: string | null;
  trend_label: string | null;
  stage: number | null;
  sparkline: number[];
};

export type FinderResult = DirectoryEntry & { snapshot: FinderSnapshot | null };

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_USER_AGENT = "ResearchOS/0.1 research-pipeline@example.com";
const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 120;

/** SEC's map as entries, in SEC's order (roughly largest first), one per ticker. Pure. */
export function parseSecDirectory(raw: unknown): DirectoryEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const seen = new Set<string>();
  const out: DirectoryEntry[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { ticker, title } = value as { ticker?: unknown; title?: unknown };
    if (typeof ticker !== "string" || typeof title !== "string") continue;
    const t = ticker.trim().toUpperCase();
    if (!TICKER_PATTERN.test(t) || seen.has(t)) continue;
    seen.add(t);
    out.push({ ticker: t, name: title.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) });
  }
  return out;
}

/**
 * Directory entries for a query, best first: the exact ticker, then tickers that start with it, then names with a
 * word that starts with it, then names that contain it. Ties keep SEC's order. Pure.
 */
export function searchDirectory(entries: readonly DirectoryEntry[], query: string, limit = 8): DirectoryEntry[] {
  const q = query.trim().toUpperCase().replace(/\s+/g, " ");
  if (!q) return [];
  const scored: { entry: DirectoryEntry; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const name = entry.name.toUpperCase();
    const rank = entry.ticker === q ? 0
      : entry.ticker.startsWith(q) ? 1
      : name.startsWith(q) || name.includes(` ${q}`) ? 2
      : q.length >= 3 && name.includes(q) ? 3
      : -1;
    if (rank >= 0) scored.push({ entry, rank, index });
  });
  scored.sort((a, b) => a.rank - b.rank || (a.rank === 1 ? a.entry.ticker.length - b.entry.ticker.length : 0) || a.index - b.index);
  return scored.slice(0, Math.max(1, Math.min(limit, 20))).map((s) => s.entry);
}

let cache: { at: number; entries: DirectoryEntry[] } | null = null;
let inflight: Promise<DirectoryEntry[]> | null = null;

/** SEC's directory, fetched at most once a day per server process. Throws when SEC can't be reached and nothing is cached. */
const fetchSec: FetchLike = (url, init) => fetchCapped(url, init, { timeoutMs: 15_000, maxBytes: 8_000_000 });

export async function secDirectory(fetchImpl: FetchLike = fetchSec, now = Date.now()): Promise<DirectoryEntry[]> {
  if (cache && now - cache.at < DIRECTORY_TTL_MS) return cache.entries;
  inflight ??= (async () => {
    try {
      const response = await fetchImpl(SEC_TICKERS_URL, { headers: { "User-Agent": SEC_USER_AGENT } });
      if (!response.ok) throw new Error(`SEC ticker map failed: ${response.status}`);
      const entries = parseSecDirectory(await response.json());
      if (!entries.length) throw new Error("SEC ticker map was empty");
      cache = { at: now, entries };
      return entries;
    } catch (error) {
      if (cache) return cache.entries; // stale beats nothing
      throw error;
    } finally { inflight = null; }
  })();
  return inflight;
}

/** Test seam: forget the cached directory. */
export function resetSecDirectoryCache() { cache = null; inflight = null; }

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The finder's view of a stored snapshot. Pure; tolerates partial or older JSON. */
export function finderSnapshot(json: unknown): FinderSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const s = json as Record<string, any>;
  const ticker = str(s.ticker);
  if (!ticker) return null;
  const closes = Array.isArray(s.trend?.charts?.sparkline) ? s.trend.charts.sparkline.map((p: any) => num(p?.close)).filter((v: number | null): v is number => v !== null) : [];
  return {
    ticker,
    name: str(s.name) ?? ticker,
    price: num(s.price),
    as_of: str(s.as_of),
    pulse_grade: str(s.value?.pulse_grade?.grade),
    pq_grade: str(s.value?.pq_grade?.grade),
    trend_label: str(s.trend?.conditions?.score_label),
    stage: num(s.trend?.stage?.stage_number),
    sparkline: closes,
  };
}

/** The newest good snapshot of each of the most recently computed tickers. */
export async function recentSnapshots(sql: Sql, limit = 8): Promise<FinderSnapshot[]> {
  const rows = await sql`
    SELECT snapshot_json FROM (
      SELECT DISTINCT ON (ticker) ticker, snapshot_json, computed_at FROM quant_snapshots
      WHERE status IN ('ok', 'partial') ORDER BY ticker, as_of_day DESC
    ) latest ORDER BY computed_at DESC LIMIT ${Math.max(1, Math.min(limit, 24))}`;
  return rows.map((r) => finderSnapshot(r.snapshot_json)).filter((s): s is FinderSnapshot => s !== null);
}

/** Newest good snapshot for each of these tickers, keyed by ticker. */
export async function snapshotsFor(sql: Sql, tickers: string[]): Promise<Map<string, FinderSnapshot>> {
  if (!tickers.length) return new Map();
  const rows = await sql`
    SELECT DISTINCT ON (ticker) snapshot_json FROM quant_snapshots
    WHERE ticker IN ${sql(tickers)} AND status IN ('ok', 'partial') ORDER BY ticker, as_of_day DESC`;
  const map = new Map<string, FinderSnapshot>();
  for (const r of rows) { const s = finderSnapshot(r.snapshot_json); if (s) map.set(s.ticker, s); }
  return map;
}
