"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import ui from "@/components/research-ui.module.css";

interface Asset { id: string; canonical_name: string; asset_kind: string; sector?: string | null; }
interface ReviewItem { run_id: string; asset_name: string; run_type: string; }

export default function HomePage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [assetsRes, queueRes] = await Promise.all([fetch("/api/assets"), fetch("/api/review/queue")]);
      if (!assetsRes.ok || !queueRes.ok) throw new Error("Unable to load your workspace.");
      setAssets(await assetsRes.json());
      setQueue(await queueRes.json());
    } catch { setError("Unable to load your workspace."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  return <div className={ui.page}>
    <header className={ui.heading}><h1>Your research</h1><Link href="/research/new" className={ui.primary}>Start research<ArrowRight size={16}/></Link></header>
    {loading ? <p className={ui.empty} role="status">Loading research…</p> : error ? <p className={ui.error} role="alert">{error}<button onClick={load}>Try again</button></p> : <>
      <section className={ui.section}>
        <div className={ui.sectionHead}><h2>Awaiting review</h2><span className={ui.muted}>{queue.length}</span></div>
        {queue.length ? queue.map((item) => <Link key={item.run_id} href={`/review?run=${item.run_id}`} className={ui.row}>
          <div><div className={ui.rowTitle}>{item.asset_name}</div><div className={ui.rowMeta}>{item.run_type.replace(/_/g, " ")}</div></div>
          <ArrowRight size={18} />
        </Link>) : <p className={ui.empty}>No reviews waiting.</p>}
      </section>
      <section className={ui.section}>
        <div className={ui.sectionHead}><h2>Assets</h2><span className={ui.muted}>{assets.length}</span></div>
        {assets.slice(0, 6).map((asset) => <Link key={asset.id} href={`/assets/${asset.id}/view`} className={ui.row}>
          <div><div className={ui.rowTitle}>{asset.canonical_name}</div><div className={ui.rowMeta}>{[asset.asset_kind.replace(/_asset/g, "").replace(/_/g, " "), asset.sector].filter(Boolean).join(" · ")}</div></div>
          <ArrowUpRight size={18} />
        </Link>)}
        {!assets.length && <p className={ui.empty}>No assets yet.</p>}
      </section>
      {assets.length > 6 && <footer className={ui.actions}><Link href="/assets" className={ui.textLink}>View all assets<ArrowRight size={16} /></Link></footer>}
    </>}
  </div>;
}
