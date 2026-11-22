"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ui from "@/components/research-ui.module.css";
import cards from "@/components/asset-cards.module.css";
import styles from "./home.module.css";
import { AssetCard, stageOf, words, type AssetOverview } from "@/components/asset-cards";
import { CompanyLogo, Leadership } from "@/components/company/company";
import { KeyNumbers, ValueRuler, money, signedPercent } from "@/components/visuals/valuation-visuals";

interface ReviewItem { run_id: string; asset_id: string; asset_name: string; run_type: string; priority?: string | null; research_question?: string | null }

const greeting = (hour: number) => hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

/** Today (design F01): what needs a decision, the newest valuation up front, then every asset as a card. */
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
      const [assetsRes, queueRes] = await Promise.all([fetch("/api/assets/overview"), fetch("/api/review/queue")]);
      if (!assetsRes.ok || !queueRes.ok) throw new Error();
      setAssets(await assetsRes.json());
      setQueue(await queueRes.json());
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
        <div className={ui.eyebrow}>{now ? now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }) : " "}</div>
        <h1>{now ? greeting(now.getHours()) : "Welcome back"}. {loading ? "" : decisions ? `${decisions} ${decisions === 1 ? "report needs" : "reports need"} your decision.` : "Nothing is waiting on you."}</h1>
      </div>
      <Link href="/research/new" className={ui.primary}>Start research</Link>
    </header>

    {loading ? <p className={ui.muted} role="status">Loading research…</p> : error ? <p className={ui.error} role="alert">{error}<button onClick={() => void load()}>Try again</button></p> : <>
      {featured && fs && <>
        <article className={styles.featured} aria-labelledby="featured-title">
          <div className={styles.featuredText}>
            <div className={styles.featuredHead}>
              <CompanyLogo subject={{ asset_id: featured.id }} name={featured.canonical_name} ticker={featured.ticker} size={52} />
              <div>
                <div className={ui.eyebrow}>Latest valuation · {words(featured.snapshot_run?.status)}</div>
                <h2 id="featured-title">{featured.canonical_name}</h2>
              </div>
            </div>
            <p className={styles.verdict}>
              The team values a share at <strong>{money(fs.values.base, fs.currency)}</strong> in the base case. It trades at <strong>{money(fs.price, fs.currency)}</strong>{fs.price_verified ? "" : " (unverified)"}, a gap of <strong data-tone={fs.gap.base != null && fs.gap.base < 0 ? "bad" : "good"}>{signedPercent(fs.gap.base)}</strong>.
              {fs.values.bull != null && <> The hopeful case is {money(fs.values.bull, fs.currency)}.</>}
            </p>
            <Leadership subject={{ asset_id: featured.id }} compact />
            <div className={styles.featuredActions}>
              <Link className={ui.primary} href={`/assets/${featured.id}/view?run=${featured.snapshot_run?.id}`}>Read the research</Link>
              {featuredReview ? <Link className={ui.secondary} href={`/review?run=${featuredReview.run_id}`}>Review the report</Link>
                : <Link className={ui.secondary} href={`/assets/${featured.id}/view?view=valuation&run=${featured.snapshot_run?.id}`}>Valuation details</Link>}
            </div>
          </div>
          <div className={styles.featuredVisual}><ValueRuler snapshot={fs} caption={false} /></div>
        </article>
        <KeyNumbers snapshot={fs} kpis={3} label={`${featured.canonical_name} key numbers`} />
      </>}

      <div className={ui.grid}>
        <section className={ui.s8} aria-labelledby="research-title">
          <div className={styles.sectionHead}><h2 id="research-title">Your research</h2><Link href="/assets" className={ui.textLink}>All research</Link></div>
          {assets.length ? <div className={cards.cards}>{assets.map((asset) => <AssetCard key={asset.id} asset={asset} reviewing={reviewing} />)}</div>
            : <p className={`${ui.tile} ${ui.empty}`}>No assets yet. Start research to add one.</p>}
        </section>
        <aside className={`${ui.s4} flex flex-col gap-4`}>
          <section className={ui.tile} aria-labelledby="waiting-title">
            <div className={ui.tileHead}><h2 id="waiting-title">Waiting on you</h2><Link href="/review" className={ui.textLink}>Open queue</Link></div>
            {queue.length ? <div className={styles.queue}>{queue.map((item) => {
              const asset = assets.find((a) => a.id === item.asset_id);
              return <Link key={item.run_id} href={`/review?run=${item.run_id}`} className={styles.queueRow}>
                <CompanyLogo subject={{ asset_id: item.asset_id }} name={item.asset_name} ticker={asset?.ticker} size={32} />
                <span><strong>{item.asset_name}</strong><em>{words(item.run_type)} · {item.run_id.slice(0, 8)}</em></span>
                <span className={ui.status} data-status="waiting_for_human">{words(item.priority) || "Medium"}</span>
              </Link>;
            })}</div> : <p className={ui.empty}>All reviews are decided.</p>}
          </section>
          <section className={ui.tile} aria-labelledby="stages-title">
            <div className={ui.tileHead}><h2 id="stages-title">Where things stand</h2></div>
            <dl className={ui.kv}>{(["review", "rework", "running", "done", "idea"] as const).map((key) => {
              const label = { review: "Needs your decision", rework: "Needs more work", running: "Researching", done: "Decided", idea: "Not started" }[key];
              return <div key={key} className="contents"><dt>{label}</dt><dd>{assets.filter((a) => stageOf(a, reviewing).key === key).length}</dd></div>;
            })}</dl>
          </section>
        </aside>
      </div>
    </>}
  </div>;
}
