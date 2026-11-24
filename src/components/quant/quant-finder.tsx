"use client";
/**
 * The Quant finder (/quant): a big type-ahead search over SEC's ticker directory with each match's grades when it has
 * been computed, quick picks, and the recently checked tickers as cards. Code only, no model calls.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { CompanyLogo } from "@/components/company/company";
import { Card } from "@/components/ui/primitives";
import ui from "@/components/research-ui.module.css";
import type { FinderResult, FinderSnapshot } from "@/lib/quant/directory";
import { TICKER_PATTERN } from "@/lib/quant/ticker";
import { Sparkline } from "./quant-charts";
import { gradeTone } from "./tones";
import styles from "./finder.module.css";

const QUICK_PICKS = ["AAPL", "MSFT", "NVDA", "GOOGL", "KO", "JPM", "NEM", "BRK-B"] as const;
const money = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);
const href = (ticker: string) => `/quant/${encodeURIComponent(ticker)}`;

type Option = { kind: "result"; result: FinderResult } | { kind: "open"; ticker: string };

function Grades({ s }: { s: FinderSnapshot }) {
  if (!s.pq_grade) return null;
  return <span className={styles.grades}>
    {s.pq_grade && <span className={styles.grade} data-grade={gradeTone(s.pq_grade)} title="PQ-Grade: value gap and upside versus downside"><small>PQ</small>{s.pq_grade}</span>}
  </span>;
}

function RecentCard({ s }: { s: FinderSnapshot }) {
  const change = s.sparkline.length > 1 ? s.sparkline[s.sparkline.length - 1] / s.sparkline[0] - 1 : null;
  return <Link href={href(s.ticker)} className={styles.recent} aria-label={`Open ${s.name} (${s.ticker})`}>
    <div className={styles.recentHead}>
      <CompanyLogo subject={{ name: s.name, ticker: s.ticker, kind: "equity" }} name={s.name} ticker={s.ticker} size={36} />
      <div className={styles.recentWho}><strong>{s.name}</strong><span>{s.ticker}</span></div>
    </div>
    <div className={styles.recentPrice}>
      <b>{money(s.price)}</b>
      {change !== null && <span data-tone={change < 0 ? "bad" : "good"}>{change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change * 100).toFixed(1)}% 3m</span>}
    </div>
    <Sparkline points={s.sparkline.map((close) => ({ close }))} />
    <div className={styles.recentFoot}>
      <Grades s={s} />
      <span className={styles.trend}>{s.stage ? `Stage ${s.stage}` : s.trend_label ?? ""}</span>
    </div>
  </Link>;
}

export function QuantFinder() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<FinderResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [directoryDown, setDirectoryDown] = useState(false);
  const [recent, setRecent] = useState<FinderSnapshot[] | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/quant-finder", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setRecent(Array.isArray(d?.recent) ? d.recent : []); }).catch(() => { if (alive) setRecent([]); });
    return () => { alive = false; };
  }, []);

  // Type-ahead, debounced; a stale reply never overwrites a newer one.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let alive = true;
    const timer = setTimeout(() => {
      fetch(`/api/quant-finder?q=${encodeURIComponent(q)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!alive) return; setResults(Array.isArray(d?.results) ? d.results : []); setDirectoryDown(d?.directory === "unavailable" || !d); })
        .catch(() => { if (alive) { setResults([]); setDirectoryDown(true); } })
        .finally(() => { if (alive) setSearching(false); });
    }, 140);
    return () => { alive = false; clearTimeout(timer); };
  }, [query]);

  // "/" focuses the search from anywhere on the page, as in most finders.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      input.current?.focus();
    };
    const outside = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", outside); };
  }, []);

  const typed = query.trim().toUpperCase();
  const options = useMemo<Option[]>(() => {
    const list: Option[] = typed ? results.map((result) => ({ kind: "result", result })) : [];
    // Offer the raw ticker only when the directory has nothing for it (a new listing, or SEC unreachable).
    if (!searching && !results.length && TICKER_PATTERN.test(typed)) list.push({ kind: "open", ticker: typed });
    return list;
  }, [results, typed, searching]);

  const go = (ticker: string) => { setOpen(false); router.push(href(ticker)); };
  const pick = (o: Option) => go(o.kind === "open" ? o.ticker : o.result.ticker);
  const submit = () => {
    if (open && options[active]) { pick(options[active]); return; }
    if (TICKER_PATTERN.test(typed)) { go(typed); return; }
    setInvalid(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0))); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  };
  const showList = open && typed.length > 0;

  return <div className={ui.page}>
    <section className={styles.hero} aria-labelledby="quant-title">
      <p className={styles.eyebrow}>Quant</p>
      <h1 id="quant-title">Value and trend for any US stock.</h1>
      <p className={styles.lede}>PragValue and PragTrend, computed from the company&apos;s filings and daily prices. No research run and no model calls.</p>

      <div className={styles.searchWrap} ref={box}>
        <div className={styles.search} data-open={showList ? "" : undefined} data-invalid={invalid ? "" : undefined}>
          <Search size={18} aria-hidden="true" />
          <label className={styles.srOnly} htmlFor="quant-ticker">Company or ticker</label>
          <input ref={input} id="quant-ticker" type="search" role="combobox" aria-expanded={showList} aria-controls="quant-results" aria-autocomplete="list"
            aria-activedescendant={showList && options[active] ? `quant-option-${active}` : undefined}
            aria-invalid={invalid} aria-describedby={invalid ? "quant-ticker-error" : undefined}
            placeholder="Search a company or ticker" autoComplete="off" spellCheck={false} value={query}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQuery(e.target.value); setSearching(!!e.target.value.trim()); setActive(0); setOpen(true); setInvalid(false); }}
            onKeyDown={onKeyDown} />
          <kbd className={styles.kbd} aria-hidden="true">/</kbd>
          <button type="button" className={`${ui.primary} ${styles.go}`} onClick={submit}>Open<ArrowRight size={15} aria-hidden="true" /></button>
        </div>
        {showList && <div id="quant-results" role="listbox" aria-label="Matching stocks" className={styles.results}>
          {options.map((o, i) => o.kind === "result"
            ? <button type="button" role="option" id={`quant-option-${i}`} key={o.result.ticker} aria-selected={i === active}
                onMouseEnter={() => setActive(i)} onClick={() => pick(o)}>
                <CompanyLogo subject={null} name={o.result.name} ticker={o.result.ticker} size={30} />
                <span className={styles.resultName}>{o.result.name}</span>
                {o.result.snapshot && <Grades s={o.result.snapshot} />}
                <span className={styles.ticker}>{o.result.ticker}</span>
              </button>
            : <button type="button" role="option" id={`quant-option-${i}`} key={`open-${o.ticker}`} aria-selected={i === active}
                onMouseEnter={() => setActive(i)} onClick={() => pick(o)} className={styles.openRow}>
                <ArrowRight size={16} aria-hidden="true" /><span className={styles.resultName}>Open <b>{o.ticker}</b></span>
              </button>)}
          {!options.length && <p role="status">{searching ? "Searching…" : "No matching US-listed stock."}</p>}
          {directoryDown && !searching && <p className={styles.note}>Company names are unavailable right now; you can still open a ticker.</p>}
        </div>}
      </div>
      {invalid && <p id="quant-ticker-error" className={styles.error} role="alert">Enter a ticker symbol: a letter, then up to nine letters, digits, dots or dashes (for example BRK-B).</p>}

      <div className={styles.picks} aria-label="Quick picks">
        <span>Try</span>
        {QUICK_PICKS.map((t) => <Link key={t} href={href(t)} className={styles.pick}>{t}</Link>)}
      </div>
    </section>

    <section aria-labelledby="recent-title" className={styles.section}>
      <div className={styles.sectionHead}><h2 id="recent-title">Recently checked</h2>{recent && recent.length > 0 && <span>{recent.length} {recent.length === 1 ? "stock" : "stocks"}</span>}</div>
      {recent === null ? <div className={styles.recentGrid} aria-hidden="true">{[0, 1, 2, 3].map((i) => <span key={i} className={styles.skeleton} />)}</div>
        : recent.length ? <div className={styles.recentGrid}>{recent.map((s) => <RecentCard key={s.ticker} s={s} />)}</div>
        : <Card><p className={ui.empty}>Nothing checked yet. Search above or try one of the quick picks.</p></Card>}
    </section>

    <section className={styles.explain} aria-label="What the Quant page shows">
      <Card title="PragValue">
        <p className={styles.explainText}>A five-year DCF in bear, base and bull cases, the company&apos;s multiple against its own history, and the PQ-Grade, which weighs the value gap together with how much the stock could gain against how much it could lose.</p>
      </Card>
      <Card title="PragTrend">
        <p className={styles.explainText}>Price against its 50, 150 and 200-day averages, Weinstein stage, relative strength against the S&amp;P 500 and its sector, and the trend conditions it meets.</p>
      </Card>
    </section>
  </div>;
}
