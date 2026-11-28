"use client";
/**
 * The Quant finder (/quant): a big type-ahead search over SEC's ticker directory and Yahoo's non-US listings, quick
 * picks, your watchlist, the recently checked tickers as cards, and what PragValue and PragTrend are. Code only, no
 * model calls.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { CompanyLogo } from "@/components/company/company";
import { Card } from "@/components/ui/primitives";
import ui from "@/components/research-ui.module.css";
import type { FinderSnapshot } from "@/lib/quant/directory";
import { WatchlistSection } from "@/components/watchlist/watchlist";
import { Sparkline } from "./quant-charts";
import { Grades, QuantSearch, quantHref } from "./quant-search";
import { QuantExplainer } from "./quant-explainer";
import { formatMoney, QuantCurrency } from "./money";
import styles from "./finder.module.css";

const QUICK_PICKS = ["AAPL", "MSFT", "NVDA", "GOOGL", "KO", "JPM", "BBCA.JK", "BRK-B"] as const;

function RecentCard({ s }: { s: FinderSnapshot }) {
  const change = s.sparkline.length > 1 ? s.sparkline[s.sparkline.length - 1] / s.sparkline[0] - 1 : null;
  return <Link href={quantHref(s.ticker)} className={styles.recent} aria-label={`Open ${s.name} (${s.ticker})`}>
    <div className={styles.recentHead}>
      <CompanyLogo subject={{ name: s.name, ticker: s.ticker, kind: "equity" }} name={s.name} ticker={s.ticker} size={36} />
      <div className={styles.recentWho}><strong>{s.name}</strong><span>{s.ticker}</span></div>
    </div>
    <div className={styles.recentPrice}>
      <b>{formatMoney(s.price, s.currency ?? "USD")}</b>
      {change !== null && <span data-tone={change < 0 ? "bad" : "good"}>{change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change * 100).toFixed(1)}% 3m</span>}
    </div>
    <QuantCurrency.Provider value={s.currency ?? "USD"}><Sparkline points={s.sparkline.map((close) => ({ close }))} /></QuantCurrency.Provider>
    <div className={styles.recentFoot}>
      <Grades s={s} />
      <span className={styles.trend}>{s.stage ? `Stage ${s.stage}` : s.trend_label ?? ""}</span>
    </div>
  </Link>;
}

export function QuantFinder() {
  const [recent, setRecent] = useState<FinderSnapshot[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/quant-finder", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setRecent(Array.isArray(d?.recent) ? d.recent : []); }).catch(() => { if (alive) setRecent([]); });
    return () => { alive = false; };
  }, []);

  return <div className={ui.page}>
    <section className={styles.hero} aria-labelledby="quant-title">
      <p className={styles.eyebrow}>Quant</p>
      <h1 id="quant-title">Value and trend for any listed stock.</h1>
      <p className={styles.lede}>PragValue and PragTrend, computed from the company&apos;s filings (SEC, or Yahoo Finance outside the US) and daily prices. Type a name or a ticker; no exchange suffix needed. No research run and no model calls.</p>
      <QuantSearch />
      <div className={styles.picks} aria-label="Quick picks">
        <span>Try</span>
        {QUICK_PICKS.map((t) => <Link key={t} href={quantHref(t)} className={styles.pick}>{t}</Link>)}
      </div>
    </section>

    <WatchlistSection />

    <section aria-labelledby="recent-title" className={styles.section}>
      <div className={styles.sectionHead}><h2 id="recent-title">Recently checked</h2>{recent && recent.length > 0 && <span>{recent.length} {recent.length === 1 ? "stock" : "stocks"}</span>}</div>
      {recent === null ? <div className={styles.recentGrid} aria-hidden="true">{[0, 1, 2, 3].map((i) => <span key={i} className={styles.skeleton} />)}</div>
        : recent.length ? <div className={styles.recentGrid}>{recent.map((s) => <RecentCard key={s.ticker} s={s} />)}</div>
        : <Card><p className={ui.empty}>Nothing checked yet. Search above or try one of the quick picks.</p></Card>}
    </section>

    <section className={styles.explain} aria-label="What the Quant page shows">
      <Card title="PragValue"><QuantExplainer kind="value" /></Card>
      <Card title="PragTrend"><QuantExplainer kind="trend" /></Card>
    </section>
  </div>;
}
