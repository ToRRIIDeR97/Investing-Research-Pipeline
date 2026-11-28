"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import cards from "@/components/asset-cards.module.css";
import styles from "./assets.module.css";
import { AssetCard, AssetRow, stageOf, type AssetOverview } from "@/components/asset-cards";
import { currentReviews } from "@/lib/review/queue-rules";
import { Card, Segmented, Tag } from "@/components/ui/primitives";
import { PageLoading } from "@/components/ui/loading";

const kinds = [["", "All"], ["equity", "Equity"], ["crypto_asset", "Crypto"], ["commodity", "Commodity"]];
const KIND_LABELS = kinds.map(([, label]) => label);
const kindLabelOf = (value: string) => kinds.find(([v]) => v === value)?.[1] ?? "All";
const stages = [["review", "Needs your decision"], ["plan", "Needs plan approval"], ["running", "Researching"], ["done", "Decided"], ["idea", "Not started"], ["stopped", "Stopped"]] as const;

/** Research: one row per company with its stage and value, filtered by stage (with counts), type and search. */
export default function AssetsPage() {
  const [assets, setAssets] = useState<AssetOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("");
  const [stage, setStage] = useState("");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"cards" | "list">("list");
  const [reviewing, setReviewing] = useState<ReadonlySet<string>>(new Set());

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [res, queueRes] = await Promise.all([fetch("/api/assets/overview"), fetch("/api/review/queue?summary=0")]);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAssets(Array.isArray(data) ? data : []);
      const queue = queueRes.ok ? await queueRes.json() : [];
      setReviewing(new Set((Array.isArray(queue) ? currentReviews(queue as { asset_id: string; replaced_by?: string | null }[]) : []).map((item) => item.asset_id)));
    } catch { setError("Unable to load assets."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const needle = query.trim().toLowerCase();
  const visible = assets.filter((asset) => (!kind || asset.asset_kind === kind) && (!stage || stageOf(asset, reviewing).key === stage)
    && [asset.canonical_name, asset.slug, asset.ticker ?? "", asset.asset_kind, asset.sector ?? ""].some((value) => value.toLowerCase().includes(needle)));
  const counts = Object.fromEntries(stages.map(([key]) => [key, assets.filter((a) => stageOf(a, reviewing).key === key).length]));

  return <div className={ui.page}>
    <header className={ui.heading}>
      <div className={ui.titleGroup}><h1>Research</h1>{!loading && <Tag tone="neutral">{assets.length} {assets.length === 1 ? "company" : "companies"}</Tag>}</div>
      <Link href="/research/new" className={ui.primary}>Start research</Link>
    </header>

    <div className={styles.toolbar}>
      <div className={styles.stages} role="group" aria-label="Where research stands">
        <button type="button" aria-pressed={stage === ""} onClick={() => setStage("")} aria-label={loading ? "All" : `All, ${assets.length}`}>All<span aria-hidden="true">{loading ? "–" : assets.length}</span></button>
        {stages.filter(([key]) => (key !== "stopped" && key !== "plan") || counts[key]).map(([key, label]) => <button key={key} type="button" aria-pressed={stage === key}
          aria-label={loading ? label : `${label}, ${counts[key]}`} onClick={() => setStage(stage === key ? "" : key)}>{label}<span aria-hidden="true">{loading ? "–" : counts[key]}</span></button>)}
      </div>
      <div className={styles.controls}>
        <div className={ui.search}><Search size={14} aria-hidden="true" /><input type="search" aria-label="Filter assets" placeholder="Search by name, ticker or sector" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <Segmented label="Asset type" options={KIND_LABELS} value={kindLabelOf(kind)} onChange={(label) => setKind(kinds.find(([, l]) => l === label)?.[0] ?? "")} />
        <Segmented label="Layout" options={["List", "Cards"] as const} value={layout === "list" ? "List" : "Cards"} onChange={(v) => setLayout(v === "List" ? "list" : "cards")} />
      </div>
    </div>

    {loading ? <PageLoading shape="cards" label="Loading your companies" /> : error ? <p className={ui.error} role="alert">{error}<button onClick={() => void load()}>Try again</button></p>
      : !visible.length ? <Card><p className={ui.empty}>{query || kind || stage ? "No assets match your filters." : "No assets yet."}</p></Card>
      : layout === "cards" ? <div className={cards.cards}>{visible.map((asset) => <AssetCard key={asset.id} asset={asset} reviewing={reviewing} />)}</div>
      : <Card><div className={cards.list}>{visible.map((asset) => <AssetRow key={asset.id} asset={asset} reviewing={reviewing} />)}</div></Card>}
  </div>;
}
