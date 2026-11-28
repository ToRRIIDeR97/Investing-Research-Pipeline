"use client";
/**
 * The Quant search: a type-ahead over SEC's ticker directory and Yahoo Finance's non-US listings (so "BBCA" or
 * "Bank Central Asia" finds BBCA.JK), each match with its grade when it has been computed. The finder shows it as
 * the hero search; the ticker page shows it compact in the tab bar (workshop quant-intl-round, S1). "/" focuses it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { CompanyLogo } from "@/components/company/company";
import ui from "@/components/research-ui.module.css";
import type { FinderResult, FinderSnapshot } from "@/lib/quant/directory";
import { TICKER_PATTERN } from "@/lib/quant/ticker";
import { gradeTone } from "./tones";
import styles from "./finder.module.css";

export const quantHref = (ticker: string) => `/quant/${encodeURIComponent(ticker)}`;

type Option = { kind: "result"; result: FinderResult } | { kind: "open"; ticker: string };

export function Grades({ s }: { s: FinderSnapshot }) {
  if (!s.pq_grade) return null;
  return <span className={styles.grades}>
    <span className={styles.grade} data-grade={gradeTone(s.pq_grade)} title="PQ Grade: value gap and upside versus downside"><small>PQ</small>{s.pq_grade}</span>
  </span>;
}

export function QuantSearch({ compact = false, placeholder, id = "quant-ticker" }: { compact?: boolean; placeholder?: string; id?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<FinderResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [directoryDown, setDirectoryDown] = useState(false);
  const [invalid, setInvalid] = useState(false);

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
    }, 160);
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
    // Offer the raw ticker only when nothing matched (a new listing, or both directories unreachable).
    if (!searching && !results.length && TICKER_PATTERN.test(typed)) list.push({ kind: "open", ticker: typed });
    return list;
  }, [results, typed, searching]);

  const go = (ticker: string) => { setOpen(false); setQuery(""); router.push(quantHref(ticker)); };
  const pick = (o: Option) => go(o.kind === "open" ? o.ticker : o.result.ticker);
  const submit = () => {
    if (open && options[active]) { pick(options[active]); return; }
    if (TICKER_PATTERN.test(typed)) { go(typed); return; }
    setInvalid(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setOpen(false); input.current?.blur(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0))); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  };
  const showList = open && typed.length > 0;
  const listId = `${id}-results`;

  return <div className={styles.searchWrap} data-compact={compact ? "" : undefined} ref={box}>
    <div className={styles.search} data-open={showList ? "" : undefined} data-invalid={invalid ? "" : undefined}>
      <Search size={compact ? 15 : 18} aria-hidden="true" />
      <label className={styles.srOnly} htmlFor={id}>Company or ticker</label>
      <input ref={input} id={id} type="search" role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showList && options[active] ? `${id}-option-${active}` : undefined}
        aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined}
        placeholder={placeholder ?? "Search a company or ticker"} autoComplete="off" spellCheck={false} value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setSearching(!!e.target.value.trim()); setActive(0); setOpen(true); setInvalid(false); }}
        onKeyDown={onKeyDown} />
      <kbd className={styles.kbd} aria-hidden="true">/</kbd>
      {!compact && <button type="button" className={`${ui.primary} ${styles.go}`} onClick={submit}>Open<ArrowRight size={15} aria-hidden="true" /></button>}
    </div>
    {showList && <div id={listId} role="listbox" aria-label="Matching stocks" className={styles.results}>
      {options.map((o, i) => o.kind === "result"
        ? <button type="button" role="option" id={`${id}-option-${i}`} key={o.result.ticker} aria-selected={i === active}
            onMouseEnter={() => setActive(i)} onClick={() => pick(o)}>
            <CompanyLogo subject={null} name={o.result.name} ticker={o.result.ticker} size={30} />
            <span className={styles.resultName}>{o.result.name}</span>
            {o.result.snapshot && <Grades s={o.result.snapshot} />}
            <span className={styles.ticker}>{o.result.ticker}{o.result.exchange ? <small> · {o.result.exchange}</small> : null}</span>
          </button>
        : <button type="button" role="option" id={`${id}-option-${i}`} key={`open-${o.ticker}`} aria-selected={i === active}
            onMouseEnter={() => setActive(i)} onClick={() => pick(o)} className={styles.openRow}>
            <ArrowRight size={16} aria-hidden="true" /><span className={styles.resultName}>Open <b>{o.ticker}</b></span>
          </button>)}
      {!options.length && <p role="status">{searching ? "Searching…" : "No matching stock."}</p>}
      {directoryDown && !searching && <p className={styles.note}>US company names are unavailable right now; you can still open a ticker.</p>}
    </div>}
    {invalid && <p id={`${id}-error`} className={styles.error} role="alert">Enter a ticker symbol: a letter, then up to nine letters, digits, dots or dashes (for example BRK-B or BBCA.JK).</p>}
  </div>;
}
