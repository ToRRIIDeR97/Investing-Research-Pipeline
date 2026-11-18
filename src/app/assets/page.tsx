"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import { AssetTable, type AssetRow } from "@/components/asset-table";

const filters = [["", "All"], ["equity", "Equity"], ["crypto_asset", "Crypto"], ["commodity", "Commodity"]];

export default function AssetsPage() {
  const [assets, setAssets] = useState<AssetRow[]>([]);
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
  const visible = assets.filter((asset) => (!filter || asset.asset_kind === filter) && [asset.canonical_name, asset.slug, asset.asset_kind, asset.sector || "", asset.status || ""].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));

  return <div className={ui.page}>
    <header className={ui.heading}>
      <div className={ui.titleGroup}><h1>Research</h1><span className={ui.muted}>{loading ? "" : `${assets.length} assets`}</span></div>
      <Link href="/research/new" className={ui.primary}>Start research</Link>
    </header>
    <section className={ui.tile}>
      <div className={ui.toolbar}>
        <div className={ui.search}><Search size={14} aria-hidden="true" /><input type="search" aria-label="Filter assets" placeholder="Filter by name, ticker or sector" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className={ui.filters} role="group" aria-label="Asset type">{filters.map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      </div>
      {loading ? <p className={ui.empty} role="status">Loading assets…</p> : error ? <p className={`${ui.error} px-3.5`} role="alert">{error}<button onClick={load}>Try again</button></p>
        : visible.length ? <AssetTable assets={visible} /> : <p className={ui.empty}>{query || filter ? "No assets match your search." : "No assets yet."}</p>}
    </section>
  </div>;
}
