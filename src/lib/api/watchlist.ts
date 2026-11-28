/**
 * The watchlist: stocks starred on the Quant or Research pages (`watchlist_items`). Each item carries the newest
 * Quant snapshot's price, grade and sparkline when one exists, so the list renders without computing anything.
 */
import type postgres from "postgres";
import { TICKER_PATTERN } from "@/lib/quant/ticker";
import { finderSnapshot, type FinderSnapshot } from "@/lib/quant/directory";

type Sql = ReturnType<typeof postgres>;

export type WatchlistItem = {
  ticker: string;
  name: string;
  asset_id: string | null;
  added_at: string;
  snapshot: FinderSnapshot | null;
};

/** An upper-cased ticker the Quant page accepts, or null. */
export function normalizeWatchTicker(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  return TICKER_PATTERN.test(t) ? t : null;
}

const cleanName = (raw: unknown) => (typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "");

export async function listWatchlist(sql: Sql): Promise<WatchlistItem[]> {
  const rows = await sql`
    SELECT w.ticker, w.name, w.asset_id, w.added_at, s.snapshot_json
    FROM watchlist_items w
    LEFT JOIN LATERAL (
      SELECT snapshot_json FROM quant_snapshots q WHERE q.ticker = w.ticker AND q.status IN ('ok', 'partial')
      ORDER BY q.as_of_day DESC LIMIT 1
    ) s ON true
    ORDER BY w.added_at DESC`;
  return rows.map((r) => ({
    ticker: String(r.ticker),
    name: String(r.name || r.ticker),
    asset_id: r.asset_id ? String(r.asset_id) : null,
    added_at: new Date(r.added_at).toISOString(),
    snapshot: finderSnapshot(r.snapshot_json),
  }));
}

/** Adds a ticker (idempotent: a second add keeps the first date and fills a missing name or asset link). */
export async function addToWatchlist(sql: Sql, input: { ticker: unknown; name?: unknown; asset_id?: unknown }): Promise<WatchlistItem | null> {
  const ticker = normalizeWatchTicker(input.ticker);
  if (!ticker) return null;
  const name = cleanName(input.name) || null;
  let assetId: string | null = typeof input.asset_id === "string" && /^[0-9a-f-]{36}$/i.test(input.asset_id) ? input.asset_id : null;
  if (assetId) {
    const [found] = await sql`SELECT id FROM assets WHERE id = ${assetId}`;
    if (!found) assetId = null;
  }
  if (!assetId) {
    // A researched company that lists this ticker (or whose slug is it) links the item to its research.
    const [owned] = await sql`
      SELECT a.id FROM assets a
      WHERE a.status IS DISTINCT FROM 'reference' AND (upper(a.slug) = ${ticker} OR EXISTS (
        SELECT 1 FROM instruments i JOIN listings l ON l.instrument_id = i.id WHERE i.asset_id = a.id AND upper(l.symbol) = ${ticker}))
      ORDER BY a.created_at LIMIT 1`;
    assetId = owned ? String(owned.id) : null;
  }
  await sql`
    INSERT INTO watchlist_items (ticker, name, asset_id) VALUES (${ticker}, ${name}, ${assetId})
    ON CONFLICT (ticker) DO UPDATE SET name = COALESCE(watchlist_items.name, EXCLUDED.name), asset_id = COALESCE(watchlist_items.asset_id, EXCLUDED.asset_id)`;
  return (await listWatchlist(sql)).find((i) => i.ticker === ticker) ?? null;
}

export async function removeFromWatchlist(sql: Sql, rawTicker: unknown): Promise<boolean> {
  const ticker = normalizeWatchTicker(rawTicker);
  if (!ticker) return false;
  const rows = await sql`DELETE FROM watchlist_items WHERE ticker = ${ticker} RETURNING ticker`;
  return rows.length > 0;
}
