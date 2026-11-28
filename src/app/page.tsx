"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ui from "@/components/research-ui.module.css";
import cards from "@/components/asset-cards.module.css";
import styles from "./home.module.css";
import { AssetCard, stageOf, type AssetOverview } from "@/components/asset-cards";
import { CompanyLogo } from "@/components/company/company";
import { money } from "@/components/visuals/valuation-visuals";
import { BigNumber, Card, Tag } from "@/components/ui/primitives";
import { formatGap } from "@/lib/ui/chart-math";
import { currentReviews } from "@/lib/review/queue-rules";
import { waitingOnYou } from "@/lib/research/run-flow";
import { PageLoading } from "@/components/ui/loading";
import { WatchlistSection } from "@/components/watchlist/watchlist";

interface ReviewItem { run_id: string; asset_id: string; asset_name: string; run_type: string; priority?: string | null; research_question?: string | null }

const STAGES = [["review", "Needs your decision"], ["plan", "Needs plan approval"], ["running", "Researching"], ["done", "Decided"], ["stopped", "Stopped"], ["idea", "Not started"]] as const;

const greeting = (hour: number) => hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

/** Home: what needs a decision, the newest valuation up front, then every asset as a card. */
export default function HomePage() {
  const [assets, setAssets] = useState<AssetOverview[]>([]);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [assetsRes, queueRes] = await Promise.all([fetch("/api/assets/overview"), fetch("/api/review/queue?summary=0")]);
      if (!assetsRes.ok || !queueRes.ok) throw new Error();
      setAssets(await assetsRes.json());
      // One decision per company: older waiting runs of a company (replaced_by) are not counted or listed.
      const queueData = await queueRes.json();
      setQueue(Array.isArray(queueData) ? currentReviews(queueData as (ReviewItem & { replaced_by?: string | null })[]) : []);
    } catch { setError("Unable to load your workspace."); }
    finally { setLoading(false); }
  }
  useEffect(() => { setNow(new Date()); void load(); }, []);

  // The featured asset: the newest valuation, so the first thing on screen is a real number.
  const featured = [...assets].filter((a) => a.snapshot?.values.base != null)
    .sort((a, b) => String(b.snapshot_run?.created_at).localeCompare(String(a.snapshot_run?.created_at)))[0] ?? null;
  const fs = featured?.snapshot ?? null;
  const featuredReview = featured ? queue.find((item) => item.asset_id === featured.id) : undefined;
  // Final reviews and plans to approve: everything a run is waiting on the person for.
  const waiting = waitingOnYou(queue, assets);
  const decisions = waiting.length;
  const reviewing = new Set(queue.map((item) => item.asset_id));

  return <div className={ui.page}>
    <header className={styles.header}>
      <div>
        <p className={styles.date}>{now ? now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }) : " "}</p>
        <h1>{now ? greeting(now.getHours()) : "Welcome back"}. {loading ? "" : decisions ? `${decisions} ${decisions === 1 ? "thing is" : "things are"} waiting on you.` : "Nothing is waiting on you."}</h1>
      </div>
      <Link href="/research/new" className={ui.primary}>Start research</Link>
    </header>

    {loading ? <PageLoading shape="cards" label="Loading your research" /> : error ? <p className={ui.error} role="alert">{error}<button onClick={() => void load()}>Try again</button></p> : <>
      {featured && fs && <Card className={styles.featured}>
        <div className={styles.featuredHead}>
          <CompanyLogo subject={{ asset_id: featured.id }} name={featured.canonical_name} ticker={featured.ticker} size={64} />
          <div><h2>{featured.canonical_name}</h2><Tag tone={stageOf(featured, reviewing).tone}>{stageOf(featured, reviewing).label}</Tag></div>
        </div>
        <div className={styles.featuredNumbers}>
          <BigNumber label="Value per share" value={money(fs.values.base, fs.currency)} />
          <BigNumber label="Price" value={money(fs.price, fs.currency)} />
          <div className={styles.gap}><span>vs price</span><strong data-tone={fs.gap.base == null ? undefined : fs.gap.base < 0 ? "bad" : "good"}>{formatGap(fs.gap.base)}</strong></div>
        </div>
        <p className={styles.verdict}>The base case values a share at {money(fs.values.base, fs.currency)} against a {money(fs.price, fs.currency)} price{fs.price_verified ? "" : " (unverified)"}.{fs.values.bull != null && <> The hopeful case is {money(fs.values.bull, fs.currency)}.</>}</p>
        <div className={styles.featuredActions}>
          <Link className={ui.primary} href={`/assets/${featured.id}/view?view=memo&run=${featured.snapshot_run?.id}`}>Read the research</Link>
          {featuredReview ? <Link className={ui.secondary} href={`/review?run=${featuredReview.run_id}`}>Review the report</Link>
            : <Link className={ui.secondary} href={`/assets/${featured.id}/view?view=valuation&run=${featured.snapshot_run?.id}`}>Valuation details</Link>}
        </div>
      </Card>}

      <WatchlistSection showEmpty headClass={styles.sectionHead} />

      <div className={styles.layout}>
        <section aria-labelledby="research-title" className={styles.main}>
          <div className={styles.sectionHead}><h2 id="research-title">Your research</h2><Link href="/assets" className={ui.textLink}>All research</Link></div>
          {assets.length ? <div className={cards.cards}>{assets.map((asset) => <AssetCard key={asset.id} asset={asset} reviewing={reviewing} />)}</div>
            : <Card><p className={ui.empty}>No assets yet. Start research to add one.</p></Card>}
        </section>
        <aside className={styles.side}>
          {/* Each column opens with a section heading outside its card, so the first cards on both sides line up. */}
          <section aria-labelledby="waiting-title">
          <div className={styles.sectionHead}><h2 id="waiting-title">Waiting on you</h2><Link href="/review" className={ui.textLink}>Open queue</Link></div>
          <Card>
            {waiting.length ? <div className={styles.queue}>{waiting.map((item) =>
              <Link key={item.run_id} href={item.href} className={styles.queueRow} aria-label={`${item.kind === "plan" ? "Approve" : "Review"} ${item.asset_name}`}>
                <CompanyLogo subject={{ asset_id: item.asset_id }} name={item.asset_name} ticker={item.ticker} size={32} />
                <strong>{item.asset_name}</strong>
                <Tag tone="waiting">{item.label}</Tag>
              </Link>)}</div> : <p className={ui.empty}>Nothing to approve or review. Plans and reports that need you show up here.</p>}
          </Card>
          </section>
          <section aria-labelledby="stand-title">
          <div className={styles.sectionHead}><h2 id="stand-title">Where things stand</h2></div>
          <Card>
            <dl className={styles.stand}>{STAGES.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{assets.filter((a) => stageOf(a, reviewing).key === key).length}</dd></div>)}</dl>
          </Card>
          </section>
        </aside>
      </div>
    </>}
  </div>;
}
