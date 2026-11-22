"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import cards from "@/components/asset-cards.module.css";
import styles from "./assets.module.css";
import { AssetCard, AssetRow, stageOf, type AssetOverview } from "@/components/asset-cards";

const kinds = [["", "All"], ["equity", "Equity"], ["crypto_asset", "Crypto"], ["commodity", "Commodity"]];
const stages = [["review", "Needs your decision"], ["rework", "Needs more work"], ["running", "Researching"], ["done", "Decided"], ["idea", "Not started"], ["stopped", "Stopped"]] as const;

/** Research (design F10): where every asset stands, then each asset with its logo, stage and value. */
export default function AssetsPage() {
  const [assets, setAssets] = useState<AssetOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("");
  const [stage, setStage] = useState("");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"cards" | "list">("cards");
  const [reviewing, setReviewing] = useState<ReadonlySet<string>>(new Set());

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [res, queueRes] = await Promise.all([fetch("/api/assets/overview"), fetch("/api/review/queue")]);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAssets(Array.isArray(data) ? data : []);
      const queue = queueRes.ok ? await queueRes.json() : [];
      setReviewing(new Set((Array.isArray(queue) ? queue : []).map((item: { asset_id: string }) => item.asset_id)));
    } catch { setError("Unable to load assets."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const needle = query.trim().toLowerCase();
  const visible = assets.filter((asset) => (!kind || asset.asset_kind === kind) && (!stage || stageOf(asset, reviewing).key === stage)
    && [asset.canonical_name, asset.slug, asset.ticker ?? "", asset.asset_kind, asset.sector ?? ""].some((value) => value.toLowerCase().includes(needle)));
  const counts = Object.fromEntries(stages.map(([key]) => [key, assets.filter((a) => stageOf(a, reviewing).key === key).length]));
  const max = Math.max(1, ...Object.values(counts));

  return <div className={ui.page}>
    <header className={ui.heading}>
      <div className={ui.titleGroup}><h1>Research</h1><span className={ui.muted}>{loading ? "" : `${assets.length} assets, from idea to decision`}</span></div>
      <Link href="/research/new" className={ui.primary}>Start research</Link>
    </header>

    <section className={styles.river} aria-label="Where research stands">
      {stages.filter(([key]) => key !== "stopped" || counts.stopped).map(([key, label]) => <button key={key} type="button" className={styles.stage} aria-pressed={stage === key}
        data-attention={key === "review" && counts[key] > 0 ? "true" : undefined} onClick={() => setStage(stage === key ? "" : key)}>
        <span className={styles.stageCount}>{loading ? "–" : counts[key]}</span>
        <span className={styles.stageLabel}>{label}</span>
        <span className={styles.stageBar} aria-hidden="true"><i style={{ width: `${(counts[key] / max) * 100}%` }} /></span>
      </button>)}
    </section>

    <div className={styles.toolbar}>
      <div className={ui.search}><Search size={14} aria-hidden="true" /><input type="search" aria-label="Filter assets" placeholder="Filter by name, ticker or sector" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className={ui.filters} role="group" aria-label="Asset type">{kinds.map(([value, label]) => <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div>
      <div className={ui.filters} role="group" aria-label="Layout"><button aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>Cards</button><button aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button></div>
    </div>

    {loading ? <p className={ui.muted} role="status">Loading assets…</p> : error ? <p className={ui.error} role="alert">{error}<button onClick={() => void load()}>Try again</button></p>
      : !visible.length ? <p className={`${ui.tile} ${ui.empty}`}>{query || kind || stage ? "No assets match your filters." : "No assets yet."}</p>
      : layout === "cards" ? <div className={cards.cards}>{visible.map((asset) => <AssetCard key={asset.id} asset={asset} reviewing={reviewing} />)}</div>
      : <section className={ui.tile}><div className={cards.list}>{visible.map((asset) => <AssetRow key={asset.id} asset={asset} reviewing={reviewing} />)}</div></section>}
  </div>;
}
