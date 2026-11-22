"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { CompanyLogo } from "@/components/company/company";

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
  // Only a company passed in from a theme is looked up (once); typing in the form never triggers lookups.
  const [prefill] = useState(() => prefillTicker && params.get("name") ? { name: (params.get("name") ?? "").slice(0, 200), ticker: prefillTicker, kind: "equity" } : null);
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
    <ol className="mb-4 flex flex-wrap gap-2 text-[12px] font-semibold" aria-label="Steps">
      {["Pick the company", "Set the question and budget", "Approve the research plan (gate 1)", "Review the final report (gate 2)"].map((step, index) => <li key={step} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${index === 0 ? "border-[var(--navy)] bg-[var(--navy-soft)] text-[var(--navy)]" : "border-[var(--line)] bg-[var(--tile)] text-[var(--ink-2)]"}`}>
        <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${index === 0 ? "bg-[var(--navy)] text-[var(--tile)]" : "bg-[var(--soft)]"}`}>{index + 1}</span>{step}</li>)}
    </ol>
    {error && <p role="alert" className={ui.error}>{error}</p>}
    <div className={ui.grid}>
      <section className={`${ui.tile} ${ui.s7}`}>
        <div className={ui.tileHead}><h2>Existing assets</h2><span className={ui.muted}>{assets.length}</span></div>
        {assets.length ? <div className={ui.list}>
          {assets.map((a) => { const fromTheme = !!prefillTicker && a.slug === prefillTicker.toLowerCase();
            return <Link key={a.id} href={`/assets/${a.id}/run?new=1`} className={ui.row} aria-current={fromTheme ? "true" : undefined}>
              <span className="flex min-w-0 items-center gap-3"><CompanyLogo subject={{ asset_id: a.id }} name={a.canonical_name} size={34} /><span className="min-w-0"><span className={ui.rowTitle}>{a.canonical_name}{fromTheme ? " (from your theme)" : ""}</span><span className={`${ui.rowMeta} block`}>{a.slug}</span></span></span>
              <span className={ui.textLink}>Start</span>
            </Link>; })}
        </div> : <p className={ui.empty}>No assets yet.</p>}
      </section>
      <section className={`${ui.tile} ${ui.s5}`}>
        <div className={ui.tileHead}><h2>Add a listed company</h2></div>
        <form onSubmit={add} className={`${ui.form} ${ui.tileBody}`}>
          {prefill && <div className="flex items-center gap-3"><CompanyLogo subject={prefill} name={prefill.name} ticker={prefill.ticker} size={44} /><span className={ui.muted}>From your theme&apos;s shortlist. Logo and leadership come from Wikipedia, matched by ticker.</span></div>}
          <label className={ui.field}>Company name<input required maxLength={500} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className={ui.field}>Ticker<input required pattern="[A-Za-z0-9-]+" maxLength={30} placeholder="SOFI" value={ticker} onChange={(e) => setTicker(e.target.value)} /></label>
          <div><button className={ui.primary} disabled={busy}>{busy ? "Adding company…" : "Continue"}</button></div>
        </form>
      </section>
    </div>
  </div>;
}
