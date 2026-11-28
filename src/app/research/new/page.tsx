"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { CompanyLogo } from "@/components/company/company";
import { Tag } from "@/components/ui/primitives";
import { FlowStepper } from "@/components/run-flow";
import styles from "./new.module.css";

export default function NewResearchPage() {
  return <Suspense fallback={null}><NewResearch /></Suspense>;
}

type Asset = { id: string; canonical_name: string; slug: string; asset_kind?: string };
type Listed = { symbol: string; name: string; exchange: string | null; sector: string | null; industry: string | null; price: number | null; change_pct: number | null; currency: string | null };
type Hit = { kind: "mine"; asset: Asset } | { kind: "yahoo"; listed: Listed };
type Remote = { state: "idle" | "ok" | "down"; query: string; results: Listed[] };

const TICKER = /^[A-Za-z0-9-]{1,30}$/;
const money = (value: number, currency: string | null) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: value >= 10_000 ? 0 : 2 }).format(value); }
  catch { return value.toFixed(2); }
};

/**
 * Start research, step 1 of the guided flow: one search bar over your companies and Yahoo Finance.
 * Picking a Yahoo result adds the company (name and symbol from Yahoo), then the run page asks the question.
 * `?ticker=&name=` (from a theme's shortlist) prefills the search and marks the matching result.
 */
function NewResearch() {
  const params = useSearchParams();
  const router = useRouter();
  const prefillTicker = (params.get("ticker") ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 30).toUpperCase();
  const fromTheme = !!prefillTicker;
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState(prefillTicker);
  const [remote, setRemote] = useState<Remote>({ state: "idle", query: "", results: [] });
  const [sel, setSel] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [manual, setManual] = useState(false);
  const [name, setName] = useState((params.get("name") ?? "").slice(0, 500));
  const [ticker, setTicker] = useState(prefillTicker);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { fetch("/api/assets").then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then(setAssets).catch(() => setError("Unable to load your companies. Reload to try again.")); }, []);

  const q = query.trim();
  // Yahoo is asked once typing pauses; an older answer never replaces a newer query's.
  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/market-search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((results: Listed[]) => setRemote({ state: "ok", query: q, results }))
        .catch((e) => { if (!controller.signal.aborted) setRemote({ state: "down", query: q, results: [] }); void e; });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q]);

  const hits = useMemo<{ mine: Asset[]; yahoo: Listed[] }>(() => {
    if (!q) return { mine: [], yahoo: [] };
    const lower = q.toLowerCase();
    const bySlug = new Map(assets.map((a) => [a.slug, a]));
    const mine = assets.filter((a) => a.canonical_name.toLowerCase().includes(lower) || a.slug.includes(lower));
    const yahoo: Listed[] = [];
    for (const listed of remote.query === q ? remote.results : []) {
      const owned = bySlug.get(listed.symbol.toLowerCase());
      if (owned) { if (!mine.includes(owned)) mine.push(owned); } else yahoo.push(listed);
    }
    return { mine, yahoo };
  }, [assets, q, remote]);
  const flat: Hit[] = [...hits.mine.map((asset) => ({ kind: "mine" as const, asset })), ...hits.yahoo.map((listed) => ({ kind: "yahoo" as const, listed }))];
  const active = Math.min(sel, Math.max(flat.length - 1, 0));

  async function addCompany(body: { canonical_name: string; slug: string; sector?: string | null; industry?: string | null }) {
    setBusy(body.slug); setError("");
    try {
      const response = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, asset_kind: "equity", sector: body.sector ?? undefined, industry: body.industry ?? undefined }) });
      const data = await response.json();
      if (response.status === 409) {
        // Already added (another tab, or a name that didn't match the search): open that company.
        const all: Asset[] = await fetch("/api/assets").then((r) => r.json());
        const existing = all.find((a) => a.slug === body.slug);
        if (existing) { router.push(`/assets/${existing.id}/run?new=1`); return; }
      }
      if (!response.ok) throw new Error(data.error || "Unable to add company.");
      router.push(`/assets/${data.id}/run?new=1`);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to add company."); setBusy(""); }
  }

  function pick(hit: Hit) {
    if (busy) return;
    if (hit.kind === "mine") { router.push(`/assets/${hit.asset.id}/run?new=1`); return; }
    void addCompany({ canonical_name: hit.listed.name, slug: hit.listed.symbol.toLowerCase(), sector: hit.listed.sector, industry: hit.listed.industry });
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(flat.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(0, active - 1)); }
    else if (e.key === "Enter" && flat[active]) { e.preventDefault(); pick(flat[active]); }
    else if (e.key === "Escape") { setQuery(""); setSel(0); }
  }

  function addManually(e: React.FormEvent) {
    e.preventDefault();
    void addCompany({ canonical_name: name.trim(), slug: ticker.trim().toLowerCase() });
  }

  const searching = !!q && remote.query !== q;
  let index = 0;
  const row = (hit: Hit) => {
    const i = index++;
    const isTheme = fromTheme && (hit.kind === "mine" ? hit.asset.slug : hit.listed.symbol.toLowerCase()) === prefillTicker.toLowerCase();
    const key = hit.kind === "mine" ? hit.asset.id : hit.listed.symbol;
    const common = { role: "option", "aria-selected": i === active, className: styles.hit, onMouseEnter: () => setSel(i), onClick: () => pick(hit) } as const;
    if (hit.kind === "mine") {
      const a = hit.asset;
      return <button type="button" key={key} {...common}>
        <CompanyLogo subject={{ asset_id: a.id }} name={a.canonical_name} size={38} />
        <span className={styles.hitName}><strong>{a.canonical_name}</strong><span>{a.asset_kind === "equity" ? a.slug.toUpperCase() : "Your company"}</span></span>
        {isTheme && <Tag tone="neutral">From your theme</Tag>}
        <span className={styles.hitGo}>Open →</span>
      </button>;
    }
    const l = hit.listed;
    return <button type="button" key={key} {...common}>
      <CompanyLogo subject={null} name={l.name} ticker={l.symbol} size={38} />
      <span className={styles.hitName}><strong>{l.name}</strong><span>{[l.symbol, l.exchange, l.industry].filter(Boolean).join(" · ")}</span></span>
      {isTheme && <Tag tone="neutral">From your theme</Tag>}
      {l.price !== null && <span className={styles.hitPrice}>{money(l.price, l.currency)}{l.change_pct !== null && <span data-dir={l.change_pct >= 0 ? "up" : "down"}>{l.change_pct >= 0 ? "+" : ""}{l.change_pct.toFixed(1)}%</span>}</span>}
      <span className={styles.hitGo}>{busy === l.symbol.toLowerCase() ? "Adding…" : "Add & start →"}</span>
    </button>;
  };

  return <div className={ui.page}>
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Start research</h1></div></header>
    <FlowStepper current={0} />
    <section className={styles.hero}>
      {fromTheme && <p className={styles.themeNote}><Tag tone="neutral">From your theme</Tag> Confirm the listing below.</p>}
      <h2>Which company?</h2>
      <p className={styles.lead}>Search every listed company on Yahoo Finance, or pick one you&apos;ve researched.</p>
      {error && <p role="alert" className={ui.error}>{error}</p>}
      <label className={styles.bar}>
        {searching ? <span className={styles.spin} aria-hidden /> : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>}
        <span className="sr-only">Search companies</span>
        <input ref={input} type="search" value={query} autoFocus autoComplete="off" spellCheck={false} role="combobox" aria-expanded={!!q} aria-controls="company-results"
          placeholder="Search any listed company by name or ticker" onChange={(e) => { setQuery(e.target.value); setSel(0); }} onKeyDown={onKey} />
        {!q && <span className={styles.source}><i aria-hidden />Yahoo Finance</span>}
      </label>

      {q && <div className={styles.drop}>
        <div id="company-results" role="listbox" className={styles.results}>
          {hits.mine.length > 0 && <><p className={styles.group}><span>Your companies</span><span>{hits.mine.length}</span></p>{hits.mine.map((asset) => row({ kind: "mine", asset }))}</>}
          {searching && <><p className={styles.group}><span>From Yahoo Finance</span></p><p className={styles.status}><span className={styles.spin} aria-hidden />Searching Yahoo Finance…</p></>}
          {!searching && hits.yahoo.length > 0 && <><p className={styles.group}><span>From Yahoo Finance</span><span>{hits.yahoo.length}</span></p>{hits.yahoo.map((listed) => row({ kind: "yahoo", listed }))}</>}
          {!searching && remote.state === "down" && <p className={styles.status}>Yahoo Finance isn&apos;t answering, so only your companies are shown.</p>}
          {!searching && remote.state === "ok" && !flat.length && <div className={styles.empty}><strong>No listed company matches &quot;{q}&quot;</strong>Check the spelling or try the ticker. Only US-style tickers (letters, digits, hyphens) can be researched.</div>}
        </div>
        <div className={styles.foot}>
          <span><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> start</span>
          <button type="button" className={styles.manualLink} onClick={() => { setManual((m) => !m); if (!ticker && TICKER.test(q)) setTicker(q.toUpperCase()); }}>{manual ? "Hide" : "Can't find it? Add by ticker"}</button>
        </div>
        {manual && <form onSubmit={addManually} className={styles.manual}>
          <label className={ui.field}>Company name<input required maxLength={500} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className={ui.field}>Ticker<input required pattern="[A-Za-z0-9-]+" maxLength={30} placeholder="SOFI" value={ticker} onChange={(e) => setTicker(e.target.value)} /></label>
          <button className={ui.primary} disabled={!!busy}>{busy ? "Adding…" : "Add and continue"}</button>
        </form>}
      </div>}

      {!q && assets.length > 0 && <div className={styles.below}>
        <p className={styles.label}>Your companies</p>
        <div className={styles.chips}>
          {assets.map((a) => <button type="button" key={a.id} className={styles.chip} onClick={() => router.push(`/assets/${a.id}/run?new=1`)}>
            <CompanyLogo subject={{ asset_id: a.id }} name={a.canonical_name} size={26} shape="round" />{a.canonical_name}
          </button>)}
        </div>
      </div>}
    </section>
  </div>;
}
