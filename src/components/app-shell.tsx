"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Search, X } from "lucide-react";
import styles from "./app-shell.module.css";

interface Asset { id: string; canonical_name: string; slug: string; }

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState("loading");

  useEffect(() => { dialog.current?.close(); setQuery(""); }, [pathname]);
  useEffect(()=>{const pointer=()=>{document.documentElement.dataset.input='pointer';};const keyboard=()=>{document.documentElement.dataset.input='keyboard';};window.addEventListener('pointerdown',pointer);window.addEventListener('keydown',keyboard);return()=>{window.removeEventListener('pointerdown',pointer);window.removeEventListener('keydown',keyboard);};},[]);

  async function openSearch() {
    dialog.current?.showModal();
    setSearchState("loading");
    try {
      const response = await fetch("/api/assets");
      if (!response.ok) throw new Error("Search unavailable");
      const data = await response.json();
      setAssets(Array.isArray(data) ? data : []);
      setSearchState("ready");
    } catch { setSearchState("error"); }
  }


  const matches = assets.filter((asset) => `${asset.canonical_name} ${asset.slug}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Kintsugi OS home">
          <span className={styles.mark}>K</span><span>Kintsugi OS</span>
        </Link>
        <nav className={styles.nav} aria-label="Main navigation">
          <Link href="/assets" aria-current={pathname.startsWith("/assets") ? "page" : undefined}>Research</Link>
          <Link href="/review" aria-current={pathname.startsWith("/review") ? "page" : undefined}>Reviews</Link>
        </nav>
        <button className={styles.iconButton} onClick={openSearch} aria-label="Search research"><Search size={22} strokeWidth={1.6} /></button>
      </header>
      <main>{children}</main>
      <dialog ref={dialog} className={styles.searchDialog} aria-label="Search research" onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}>
        <div>
          <div className={styles.searchInput}>
            <Search size={19} aria-hidden="true" />
            <input autoFocus type="search" aria-label="Search assets" placeholder="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} />
            <button className={styles.iconButton} aria-label="Close search" onClick={() => dialog.current?.close()}><X size={19} /></button>
          </div>
          <div className={styles.searchResults}>
            {searchState === "loading" ? <p role="status">Loading research…</p> : searchState === "error" ? (
              <p role="alert">Search is unavailable. <button onClick={openSearch}>Try again</button></p>
            ) : matches.length === 0 ? <p>No assets found.</p> : matches.map((asset) => (
              <Link key={asset.id} href={`/assets/${asset.id}/view`} onClick={() => dialog.current?.close()}>
                <span>{asset.canonical_name}</span><ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </div>
      </dialog>
    </div>
  );
}
