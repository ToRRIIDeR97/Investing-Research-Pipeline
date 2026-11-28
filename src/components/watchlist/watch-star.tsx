"use client";
/**
 * The watchlist store and star (workshop quant-intl-round, W1): one shared list fed by GET /api/watchlist, and the
 * star button on the Quant rail and the research header. Kept apart from the cards so the company header can use the
 * star without importing the cards (which use the company logo).
 */
import { useEffect, useSyncExternalStore } from "react";
import { Star } from "lucide-react";
import type { WatchlistItem } from "@/lib/api/watchlist";
import styles from "./watchlist.module.css";

type State = { items: WatchlistItem[] | null; error: boolean };
let state: State = { items: null, error: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (next: State) => { state = next; listeners.forEach((l) => l()); };

function load(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = fetch("/api/watchlist", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((items: WatchlistItem[]) => set({ items: Array.isArray(items) ? items : [], error: false }))
    .catch(() => set({ items: state.items, error: true }));
  return loading;
}

/** The watchlist, loaded once per page and shared by every star and list on it. */
export function useWatchlist(): State & { has: (ticker: string) => boolean } {
  const snap = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state, () => state);
  useEffect(() => { if (state.items === null) void load(); }, []);
  return { ...snap, has: (t) => !!snap.items?.some((i) => i.ticker === t.toUpperCase()) };
}

async function toggle(ticker: string, name: string, assetId: string | null | undefined, on: boolean) {
  const t = ticker.toUpperCase();
  const before = state.items ?? [];
  // Optimistic: the star flips at once; a failure flips it back.
  set({ ...state, items: on ? [{ ticker: t, name, asset_id: assetId ?? null, added_at: new Date().toISOString(), snapshot: null }, ...before.filter((i) => i.ticker !== t)] : before.filter((i) => i.ticker !== t) });
  try {
    const r = on
      ? await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: t, name, asset_id: assetId ?? undefined }) })
      : await fetch(`/api/watchlist/${encodeURIComponent(t)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(String(r.status));
    await load(true);
  } catch {
    set({ items: before, error: true });
  }
}

/** A star that adds the stock to the watchlist or takes it off. */
export function WatchStar({ ticker, name, assetId, className }: { ticker: string; name: string; assetId?: string | null; className?: string }) {
  const { has } = useWatchlist();
  const on = has(ticker);
  return <button type="button" className={`${styles.star}${className ? ` ${className}` : ""}`} aria-pressed={on}
    aria-label={on ? `Remove ${name} from your watchlist` : `Add ${name} to your watchlist`} title={on ? "On your watchlist" : "Add to watchlist"}
    onClick={() => void toggle(ticker, name, assetId, !on)}>
    <Star size={16} aria-hidden="true" fill={on ? "currentColor" : "none"} />
  </button>;
}
