"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { PragmaMark } from "@/components/brand/logo";
import { CompanyLogo } from "@/components/company/company";
import { reviewCount } from "@/lib/review/queue-rules";
import styles from "./app-shell.module.css";

interface Asset { id: string; canonical_name: string; slug: string; }

/** Pragma Research chrome: wordmark, the main links as one pill group (current one a white pill), a pill asset search with logos, a navy pill Start research. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pendingReviews, setPendingReviews] = useState<number | null>(null);

  useEffect(() => { setOpen(false); setQuery(""); }, [pathname]);
  useEffect(() => {
    const pointer = () => { document.documentElement.dataset.input = "pointer"; };
    const keyboard = () => { document.documentElement.dataset.input = "keyboard"; };
    const outside = (event: PointerEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", pointer); window.addEventListener("keydown", keyboard); window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("pointerdown", pointer); window.removeEventListener("keydown", keyboard); window.removeEventListener("pointerdown", outside); };
  }, []);
  // The review count beside Reviews; refreshed on navigation so a submitted decision lowers it.
  useEffect(() => {
    if (pathname === "/login") return;
    let cancelled = false;
    fetch("/api/review/queue").then((res) => res.ok ? res.json() : null).then((data) => { if (!cancelled && Array.isArray(data)) setPendingReviews(reviewCount(data)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [pathname]);

  async function loadAssets() {
    if (assets) return;
    setSearchError(false);
    try {
      const response = await fetch("/api/assets");
      if (!response.ok) throw new Error();
      const data = await response.json();
      setAssets(Array.isArray(data) ? data : []);
    } catch { setSearchError(true); }
  }

  const needle = query.trim().toLowerCase();
  const matches = (assets ?? []).filter((asset) => `${asset.canonical_name} ${asset.slug}`.toLowerCase().includes(needle)).slice(0, 8);
  const go = (asset: Asset) => { setOpen(false); router.push(`/assets/${asset.id}/view`); };
  const current = (prefix: string) => (prefix === "/" ? pathname === "/" : pathname.startsWith(prefix)) ? "page" as const : undefined;

  if (pathname === "/login") return <div className={styles.shell}><main className={styles.main}>{children}</main></div>;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.bar}>
          <Link href="/" className={styles.brand} aria-label="Pragma Research home"><PragmaMark size={26} /><span>Pragma Research</span></Link>
          <nav className={styles.nav} aria-label="Main">
            <Link href="/" aria-current={current("/")}>Home</Link>
            <Link href="/assets" aria-current={current("/assets")}>Research</Link>
            <Link href="/themes" aria-current={current("/themes")}>Themes</Link>
            <Link href="/review" aria-current={current("/review")}>Reviews{pendingReviews ? <span className={styles.count}>{pendingReviews}</span> : null}</Link>
          </nav>
          <div className={styles.tools}>
            <div className={styles.search} ref={box}>
              <Search size={14} aria-hidden="true" />
              <input type="search" role="combobox" aria-expanded={open} aria-controls="asset-search-results" aria-label="Search assets" placeholder="Search assets"
                value={query}
                onFocus={() => { void loadAssets(); setOpen(true); }}
                onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setOpen(false); return; }
                  if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0))); }
                  if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
                  if (event.key === "Enter" && matches[active]) { event.preventDefault(); go(matches[active]); }
                }} />
              {open && <div id="asset-search-results" role="listbox" aria-label="Assets" className={styles.results}>
                {searchError ? <p role="alert">Search is unavailable. <button type="button" onClick={() => void loadAssets()}>Try again</button></p>
                  : !assets ? <p role="status">Loading assets…</p>
                  : !matches.length ? <p>No assets found.</p>
                  : matches.map((asset, index) => <button type="button" role="option" aria-selected={index === active} key={asset.id} onMouseEnter={() => setActive(index)} onClick={() => go(asset)}>
                    <CompanyLogo subject={{ asset_id: asset.id }} name={asset.canonical_name} size={26} /><span className={styles.resultName}>{asset.canonical_name}</span><span className={styles.ticker}>{asset.slug}</span>
                  </button>)}
              </div>}
            </div>
            <Link href="/research/new" className={styles.start}>Start research</Link>
          </div>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
