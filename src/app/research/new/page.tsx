"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";

export default function NewResearchPage() {
  return <Suspense fallback={null}><NewResearch /></Suspense>;
}

/** Start research. `?ticker=&name=` (from a theme's shortlist) prefills the new-company form and marks a matching asset. */
function NewResearch() {
  const params = useSearchParams();
  const prefillTicker = (params.get("ticker") ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 30);
  const [assets, setAssets] = useState<{ id: string; canonical_name: string; slug: string }[]>([]);
  const [name, setName] = useState((params.get("name") ?? "").slice(0, 500));
  const [ticker, setTicker] = useState(prefillTicker);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  useEffect(() => { fetch("/api/assets").then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then(setAssets).catch(() => setError("Unable to load assets. Reload to try again.")); }, []);
  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canonical_name: name.trim(), slug: ticker.trim().toLowerCase(), asset_kind: "equity" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to add company.");
      router.push(`/assets/${data.id}/run?new=1`);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to add company."); } finally { setBusy(false); }
  }
  return <div className={ui.page}>
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Start research</h1><span className={ui.muted}>Choose an asset; the run type, question, budget and cutoffs come next</span></div></header>
    {error && <p role="alert" className={ui.error}>{error}</p>}
    <div className={ui.grid}>
      <section className={`${ui.tile} ${ui.s7}`}>
        <div className={ui.tileHead}><h2>Existing assets</h2><span className={ui.muted}>{assets.length}</span></div>
        {assets.length ? <div className={ui.table}><table><thead><tr><th>Asset</th><th>Slug</th><th className={ui.num}></th></tr></thead><tbody>
          {assets.map((a) => <tr key={a.id} aria-current={prefillTicker && a.slug === prefillTicker.toLowerCase() ? "true" : undefined}><td className="font-medium">{a.canonical_name}{prefillTicker && a.slug === prefillTicker.toLowerCase() ? " (from your theme)" : ""}</td><td className={ui.mono}>{a.slug}</td><td className={ui.num}><Link className={ui.textLink} href={`/assets/${a.id}/run?new=1`}>Start</Link></td></tr>)}
        </tbody></table></div> : <p className={ui.empty}>No assets yet.</p>}
      </section>
      <section className={`${ui.tile} ${ui.s5}`}>
        <div className={ui.tileHead}><h2>Add a listed company</h2></div>
        <form onSubmit={add} className={`${ui.form} ${ui.tileBody}`}>
          <label className={ui.field}>Company name<input required maxLength={500} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className={ui.field}>Ticker<input required pattern="[A-Za-z0-9-]+" maxLength={30} placeholder="SOFI" value={ticker} onChange={(e) => setTicker(e.target.value)} /></label>
          <div><button className={ui.primary} disabled={busy}>{busy ? "Adding company…" : "Continue"}</button></div>
        </form>
      </section>
    </div>
  </div>;
}
