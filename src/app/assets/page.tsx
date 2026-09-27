"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Search } from "lucide-react";
import ui from "@/components/research-ui.module.css";

interface Asset { id: string; canonical_name: string; slug: string; asset_kind: string; sector: string | null; status: string; }
const filters = [["", "All"], ["equity", "Equity"], ["crypto_asset", "Crypto"], ["commodity", "Commodity"]];

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/assets");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAssets(Array.isArray(data) ? data : []);
    } catch { setError("Unable to load assets."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  const visible = assets.filter((asset) => (!filter || asset.asset_kind === filter) && [asset.canonical_name, asset.slug, asset.asset_kind, asset.sector || "", asset.status].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));

  return <div className={ui.page}>
    <header className={ui.heading}><h1>Research</h1><Link href="/research/new" className={ui.primary}>Start research<ArrowUpRight size={16}/></Link></header>
    <div className={ui.search}><Search size={19} aria-hidden="true" /><input type="search" aria-label="Search assets" placeholder="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className={ui.filters} aria-label="Asset type">{filters.map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {loading ? <p className={ui.empty} role="status">Loading assets…</p> : error ? <p className={ui.error} role="alert">{error}<button onClick={load}>Try again</button></p> : <div className={ui.list}>
      {visible.map((asset) => <Link key={asset.id} href={`/assets/${asset.id}/view`} className={ui.row}>
        <div><div className={ui.rowTitle}>{asset.canonical_name}</div><div className={ui.rowMeta}>{[asset.asset_kind.replace(/_asset/g, "").replace(/_/g, " "), asset.sector].filter(Boolean).join(" · ")}</div></div>
        <ArrowUpRight size={18} />
      </Link>)}
      {!visible.length && <p className={ui.empty}>{query || filter ? "No assets match your search." : "No assets yet."}</p>}
    </div>}
  </div>;
}
