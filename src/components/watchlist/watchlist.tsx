"use client";
/**
 * The watchlist's row of cards on Home and the Quant finder (workshop quant-intl-round, W1). The store and the star
 * live in watch-star.tsx.
 */
import Link from "next/link";
import { CompanyLogo } from "@/components/company/company";
import { Sparkline } from "@/components/quant/quant-charts";
import { Grades, quantHref } from "@/components/quant/quant-search";
import { formatMoney, QuantCurrency } from "@/components/quant/money";
import type { WatchlistItem } from "@/lib/api/watchlist";
import finder from "@/components/quant/finder.module.css";
import { useWatchlist, WatchStar } from "./watch-star";
import styles from "./watchlist.module.css";

function WatchCard({ item }: { item: WatchlistItem }) {
  const s = item.snapshot;
  const change = s && s.sparkline.length > 1 ? s.sparkline[s.sparkline.length - 1] / s.sparkline[0] - 1 : null;
  return <div className={finder.watchCard}>
    <Link href={quantHref(item.ticker)} aria-label={`Open ${item.name} (${item.ticker}) in Quant`}>
      <div className={finder.recentHead}>
        <CompanyLogo subject={item.asset_id ? { asset_id: item.asset_id } : { name: item.name, ticker: item.ticker, kind: "equity" }} name={item.name} ticker={item.ticker} size={32} />
        <div className={finder.recentWho}><strong>{item.name}</strong><span>{item.ticker}</span></div>
      </div>
      <div className={finder.recentPrice}>
        <b>{s?.price != null ? formatMoney(s.price, s.currency ?? "USD") : "—"}</b>
        {change !== null && <span data-tone={change < 0 ? "bad" : "good"}>{change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change * 100).toFixed(1)}% 3m</span>}
      </div>
      {s && s.sparkline.length > 1 ? <QuantCurrency.Provider value={s.currency ?? "USD"}><Sparkline points={s.sparkline.map((close) => ({ close }))} /></QuantCurrency.Provider> : <span className={styles.noData}>Not checked yet: open it to compute.</span>}
      <div className={finder.recentFoot}>
        {s ? <Grades s={s} /> : <span />}
        <span className={finder.trend}>{s?.stage ? `Stage ${s.stage}` : s?.trend_label ?? ""}</span>
      </div>
    </Link>
    <WatchStar ticker={item.ticker} name={item.name} assetId={item.asset_id} className={finder.watchStar} />
  </div>;
}

/** The "Watchlist" section: a heading and a row of cards. Hidden while empty unless `showEmpty`. */
export { WatchStar };

export function WatchlistSection({ showEmpty = false, headingClass, headClass }: { showEmpty?: boolean; headingClass?: string; headClass?: string }) {
  const { items, error } = useWatchlist();
  if (items === null) return null;
  if (!items.length && !showEmpty) return null;
  return <section aria-labelledby="watchlist-title" className={styles.section}>
    <div className={headClass ?? finder.sectionHead}><h2 id="watchlist-title" className={headingClass}>Watchlist</h2>{items.length > 0 && <span>{items.length} {items.length === 1 ? "stock" : "stocks"}</span>}</div>
    {error && <p className={styles.error} role="alert">The watchlist couldn&apos;t be updated. Try again.</p>}
    {items.length ? <div className={finder.watchGrid}>{items.map((i) => <WatchCard key={i.ticker} item={i} />)}</div>
      : <p className={styles.empty}>Star a stock on its Quant or research page to follow it here.</p>}
  </section>;
}
