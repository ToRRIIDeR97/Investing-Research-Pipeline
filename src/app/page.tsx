"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ui from "@/components/research-ui.module.css";
import { AssetTable, words, type AssetRow } from "@/components/asset-table";

interface ReviewItem { run_id: string; asset_id: string; asset_name: string; run_type: string; priority?: string | null; }


export default function HomePage() {
  const [assets, setAssets] = useState<AssetRow[]>([]);
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
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Home</h1><span className={ui.muted}>Reviews waiting on you and recent research</span></div></header>
    {loading ? <p className={ui.muted} role="status">Loading research…</p> : error ? <p className={ui.error} role="alert">{error}<button onClick={load}>Try again</button></p> : <div className={ui.grid}>
      <section className={`${ui.tile} ${ui.s8}`}>
        <div className={ui.tileHead}><h2>Awaiting review</h2><Link href="/review" className={ui.textLink}>Open queue</Link></div>
        <div className={ui.stat}><strong>{queue.length}</strong><span className={ui.muted}>{queue.length === 1 ? "report needs" : "reports need"} a human decision</span></div>
        {queue.length ? <div className={ui.table}><table>
          <thead><tr><th>Asset</th><th>Run</th><th>Id</th><th className={ui.num}>Priority</th></tr></thead>
          <tbody>{queue.map((item) => <tr key={item.run_id}>
            <td><Link href={`/review?run=${item.run_id}`} className="font-medium hover:underline">{item.asset_name}</Link></td>
            <td className={ui.muted}>{words(item.run_type)}</td>
            <td className={ui.mono}>{item.run_id.slice(0, 8)}</td>
            <td className={ui.num}>{words(item.priority) || "Medium"}</td>
          </tr>)}</tbody>
        </table></div> : <p className={ui.empty}>All reviews are decided.</p>}
      </section>
      <section className={`${ui.tile} ${ui.s4}`}>
        <div className={ui.tileHead}><h2>New research</h2></div>
        <div className={`${ui.tileBody} flex flex-col gap-3`}>
          <p className={ui.muted}>Pick an asset and a run type. Each run stops at two human gates: the research plan and the final report.</p>
          <Link href="/research/new" className={ui.primary}>Start research</Link>
        </div>
      </section>
      <section className={`${ui.tile} ${ui.s12}`}>
        <div className={ui.tileHead}><h2>Recent assets</h2><Link href="/assets" className={ui.textLink}>All assets</Link></div>
        {assets.length ? <AssetTable assets={assets.slice(0, 8)} /> : <p className={ui.empty}>No assets yet.</p>}
      </section>
    </div>}
  </div>;
}
