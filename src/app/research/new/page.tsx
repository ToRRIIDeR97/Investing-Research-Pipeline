"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { CompanyLogo } from "@/components/company/company";
import { Card, Tag } from "@/components/ui/primitives";
import styles from "./new.module.css";

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
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Start research</h1></div></header>
    <ol className={styles.steps} aria-label="Steps">
      <li aria-current="step"><span>1</span>Company</li>
      <li><span>2</span>Question and budget</li>
    </ol>
    {error && <p role="alert" className={ui.error}>{error}</p>}
    <div className={ui.grid}>
      <Card title="Pick a company" action={<span>{assets.length}</span>} className={ui.s7}>
        {assets.length ? <div className={ui.list}>
          {assets.map((a) => { const fromTheme = !!prefillTicker && a.slug === prefillTicker.toLowerCase();
            return <Link key={a.id} href={`/assets/${a.id}/run?new=1`} className={styles.pick} aria-current={fromTheme ? "true" : undefined}>
              <CompanyLogo subject={{ asset_id: a.id }} name={a.canonical_name} size={36} />
              <span className={styles.pickName}><strong>{a.canonical_name}</strong><span>{a.slug.toUpperCase()}</span></span>
              {fromTheme && <Tag tone="neutral">From your theme</Tag>}
              <span className={styles.pickAction}>Start</span>
            </Link>; })}
        </div> : <p className={ui.empty}>No companies yet. Add one.</p>}
      </Card>
      <Card title="Add a listed company" className={ui.s5}>
        <form onSubmit={add} className={ui.form}>
          {prefill && <div className={styles.prefill}><CompanyLogo subject={prefill} name={prefill.name} ticker={prefill.ticker} size={44} /><span>From your theme&apos;s shortlist.</span></div>}
          <label className={ui.field}>Company name<input required maxLength={500} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className={ui.field}>Ticker<input required pattern="[A-Za-z0-9-]+" maxLength={30} placeholder="SOFI" value={ticker} onChange={(e) => setTicker(e.target.value)} /></label>
          <div><button className={ui.primary} disabled={busy}>{busy ? "Adding company…" : "Continue"}</button></div>
        </form>
      </Card>
    </div>
  </div>;
}
