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

interface ReviewItem { run_id: string; asset_id: string; asset_name: string; run_type: string; priority?: string | null; research_question?: string | null }

const STAGES = [["review", "Needs your decision"], ["running", "Researching"], ["done", "Decided"], ["stopped", "Stopped"], ["idea", "Not started"]] as const;

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
  const decisions = queue.length;
  const reviewing = new Set(queue.map((item) => item.asset_id));

  return <div className={ui.page}>
    <header className={styles.header}>
      <div>
        <p className={styles.date}>{now ? now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }) : " "}</p>
        <h1>{now ? greeting(now.getHours()) : "Welcome back"}. {loading ? "" : decisions ? `${decisions} ${decisions === 1 ? "report needs" : "reports need"} your decision.` : "Nothing is waiting on you."}</h1>
      </div>
      <Link href="/research/new" className={ui.primary}>Start research</Link>
    </header>

    {loading ? <p className={ui.muted} role="status">Loading research…</p> : error ? <p className={ui.error} role="alert">{error}<button onClick={() => void load()}>Try again</button></p> : <>
      {featured && fs && <Card className={styles.featured}>
        <div className={styles.featuredHead}>
          <CompanyLogo subject={{ asset_id: featured.id }} name={featured.canonical_name} ticker={featured.ticker} size={52} />
          <div><h2>{featured.canonical_name}</h2><Tag tone={stageOf(featured, reviewing).tone}>{stageOf(featured, reviewing).label}</Tag></div>
        </div>
        <div className={styles.featuredNumbers}>
          <BigNumber label="Value per share" value={money(fs.values.base, fs.currency)} />
          <BigNumber label="Price" value={money(fs.price, fs.currency)} />
          <div className={styles.gap}><span>vs price</span><strong data-tone={fs.gap.base == null ? undefined : fs.gap.base < 0 ? "bad" : "good"}>{formatGap(fs.gap.base)}</strong></div>
        </div>
        <p className={styles.verdict}>The base case values a share at {money(fs.values.base, fs.currency)} against a {money(fs.price, fs.currency)} price{fs.price_verified ? "" : " (unverified)"}.{fs.values.bull != null && <> The hopeful case is {money(fs.values.bull, fs.currency)}.</>}</p>
        <div className={styles.featuredActions}>
          <Link className={ui.primary} href={`/assets/${featured.id}/view?run=${featured.snapshot_run?.id}`}>Read the research</Link>
          {featuredReview ? <Link className={ui.secondary} href={`/review?run=${featuredReview.run_id}`}>Review the report</Link>
            : <Link className={ui.secondary} href={`/assets/${featured.id}/view?view=valuation&run=${featured.snapshot_run?.id}`}>Valuation details</Link>}
        </div>
      </Card>}

      <div className={styles.layout}>
        <section aria-labelledby="research-title" className={styles.main}>
          <div className={styles.sectionHead}><h2 id="research-title">Your research</h2><Link href="/assets" className={ui.textLink}>All research</Link></div>
          {assets.length ? <div className={cards.cards}>{assets.map((asset) => <AssetCard key={asset.id} asset={asset} reviewing={reviewing} />)}</div>
            : <Card><p className={ui.empty}>No assets yet. Start research to add one.</p></Card>}
        </section>
        <aside className={styles.side}>
          <Card title="Waiting on you" action={<Link href="/review" className={ui.textLink}>Open queue</Link>}>
            {queue.length ? <div className={styles.queue}>{queue.map((item) => {
              const asset = assets.find((a) => a.id === item.asset_id);
              return <Link key={item.run_id} href={`/review?run=${item.run_id}`} className={styles.queueRow} aria-label={`Open ${item.asset_name} review`}>
                <CompanyLogo subject={{ asset_id: item.asset_id }} name={item.asset_name} ticker={asset?.ticker} size={32} />
                <strong>{item.asset_name}</strong>
                <Tag tone="waiting">Needs your decision</Tag>
              </Link>;
            })}</div> : <p className={ui.empty}>All reviews are decided.</p>}
          </Card>
          <Card title="Where things stand">
            <dl className={styles.stand}>{STAGES.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{assets.filter((a) => stageOf(a, reviewing).key === key).length}</dd></div>)}</dl>
          </Card>
        </aside>
      </div>
    </>}
  </div>;
}
