"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, FolderKanban, Home, Menu, Search, ShieldCheck, X } from "lucide-react";

interface Asset {
  id: string;
  canonical_name: string;
  asset_kind: string;
}

interface SearchResult {
  kind: "asset" | "chunk";
  id: string;
  asset_id?: string | null;
  asset_name?: string | null;
  title?: string | null;
  text?: string | null;
  section_title?: string | null;
}

function navClass(active: boolean) {
  return [
    "flex h-9 items-center gap-3 rounded-md px-3 text-[13px] font-semibold transition-colors",
    active ? "bg-[#f3f6f8] text-black" : "text-gray-500 hover:bg-[#f7f8fa] hover:text-black",
  ].join(" ");
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hideSidebar = pathname.includes("/run");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [queueCount, setQueueCount] = useState(0);
  const [queueTruncated, setQueueTruncated] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function loadShellData() {
      try {
        const [assetsRes, queueRes] = await Promise.all([
          fetch("/api/assets", { signal: controller.signal }),
          fetch("/api/review/queue", { signal: controller.signal }),
        ]);
        const assetsData = await assetsRes.json().catch(() => []);
        const queueData = await queueRes.json().catch(() => []);
        if (!assetsRes.ok) throw new Error(assetsData?.error || "Unable to load assets");
        if (!queueRes.ok) throw new Error(queueData?.error || "Unable to load reviews");
        setAssets(Array.isArray(assetsData) ? assetsData.slice(0, 5) : []);
        setQueueCount(Array.isArray(queueData) ? queueData.length : 0);
        setQueueTruncated(Array.isArray(queueData) && queueData.length >= 50);
        setShellError(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setShellError(error instanceof Error ? error.message : "Workspace data unavailable");
      }
    }

    loadShellData();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
  }, [pathname]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      try {
        const response = await fetch(`/api/search?scope=workspace&q=${encodeURIComponent(query)}&limit=8`, {
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || "Search is unavailable");
        setSearchResults(Array.isArray(data?.results) ? data.results : []);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSearchError(error instanceof Error ? error.message : "Search is unavailable");
        setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  const activeAssetId = useMemo(() => pathname.match(/^\/assets\/([^/]+)/)?.[1] ?? null, [pathname]);
  const reviewLabel = queueTruncated ? "50+" : String(queueCount);
  const searchOpen = searchQuery.trim().length >= 2;

  if (hideSidebar) {
    return <main className="min-h-screen flex-1 overflow-auto bg-[#f4f7fa]">{children}</main>;
  }

  const sidebar = (
    <aside
      aria-label="Primary navigation"
      className={[
        "flex h-screen shrink-0 flex-col border-r border-[#e8edf2] bg-white/95 p-4 shadow-[8px_0_30px_rgba(17,24,39,0.03)] backdrop-blur-xl transition-all",
        collapsed ? "w-[76px]" : "w-[268px]",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="mb-5 flex items-center justify-between">
          <Link href="/" className="flex min-w-0 items-center gap-2.5 text-black" aria-label="Research OS home">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black text-[11px] font-bold text-white">K</div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="truncate text-[15px] font-bold tracking-tight">Kintsugi OS</div>
                <div className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-gray-400">Private workspace</div>
              </div>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="hidden h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-50 hover:text-black lg:flex"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-50 hover:text-black lg:hidden"
            title="Close navigation"
            aria-label="Close navigation"
          >
            <X size={16} />
          </button>
        </div>

        {!collapsed && (
          <div className="relative mb-5">
            <div className="flex h-9 items-center gap-2 rounded-md border border-gray-200 bg-[#fbfcfd] px-3 text-[12px] text-gray-400 focus-within:border-gray-400">
              <Search size={14} aria-hidden="true" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSearchQuery("");
                }}
                className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-black outline-none placeholder:text-gray-400"
                placeholder="Search workspace"
                aria-label="Search workspace"
                role="combobox"
                aria-expanded={searchOpen}
                aria-controls="workspace-search-results"
              />
            </div>
            {searchOpen && (
              <div id="workspace-search-results" role="listbox" className="absolute inset-x-0 top-11 z-20 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
                {searchLoading ? (
                  <div className="px-3 py-3 text-[11px] text-gray-400">Searching…</div>
                ) : searchError ? (
                  <div className="px-3 py-3 text-[11px] text-red-600" role="alert">{searchError}</div>
                ) : searchResults.length === 0 ? (
                  <div className="px-3 py-3 text-[11px] text-gray-400">No workspace matches.</div>
                ) : (
                  searchResults.map((result) => {
                    const assetId = result.asset_id || (result.kind === "asset" ? result.id : null);
                    if (!assetId) return null;
                    return (
                      <Link
                        key={`${result.kind}-${result.id}`}
                        href={`/assets/${assetId}/research/general`}
                        role="option"
                        className="block border-b border-gray-100 px-3 py-2.5 last:border-0 hover:bg-[#fbfcfd]"
                      >
                        <span className="block truncate text-[12px] font-bold text-black">{result.asset_name || result.title || "Asset workspace"}</span>
                        <span className="mt-0.5 block truncate text-[10px] text-gray-400">{result.kind === "asset" ? "Asset" : result.section_title || "Evidence"}{result.text ? ` · ${result.text}` : ""}</span>
                      </Link>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        <nav className="space-y-1" aria-label="Workspace sections">
          <Link href="/" className={navClass(pathname === "/")} title="Home">
            <Home size={16} aria-hidden="true" />
            {!collapsed && <span>Home</span>}
          </Link>

          <Link href="/assets" className={navClass(pathname.startsWith("/assets"))} title="Assets">
            <FolderKanban size={16} aria-hidden="true" />
            {!collapsed && <span>Assets</span>}
          </Link>

          {!collapsed && assets.length > 0 && (
            <div className="ml-[19px] mt-1 space-y-0.5 border-l border-gray-100 pl-3" aria-label="Recent assets">
              {assets.map((asset) => (
                <Link
                  key={asset.id}
                  href={`/assets/${asset.id}/research/general`}
                  className={[
                    "block truncate rounded-sm px-2 py-1.5 text-[12px] transition-colors",
                    activeAssetId === asset.id ? "bg-[#f3f6f8] font-semibold text-black" : "text-gray-500 hover:bg-gray-50 hover:text-black",
                  ].join(" ")}
                >
                  {asset.canonical_name}
                </Link>
              ))}
            </div>
          )}

          <Link href="/review" className={navClass(pathname.startsWith("/review"))} title="Review queue">
            <ShieldCheck size={16} aria-hidden="true" />
            {!collapsed && <span className="flex-1">Review queue</span>}
            {queueCount > 0 && <span className="rounded-full bg-black px-1.5 py-0.5 font-mono text-[9px] text-white" title={`${reviewLabel} review gates`} aria-label={`${reviewLabel} review gates`}>{reviewLabel}</span>}
          </Link>
        </nav>

        {shellError && !collapsed && <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-700" role="status">{shellError}</p>}
      </div>

      {!collapsed && <div className="border-t border-[#eef2f6] pt-4 text-[11px] text-gray-400">Research workspace</div>}
    </aside>
  );

  return (
    <div className="min-h-screen bg-[#f4f7fa] text-[#111111]">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-40 flex h-10 w-10 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm lg:hidden"
        title="Open navigation"
        aria-label="Open navigation"
      >
        <Menu size={18} />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Primary navigation">
          <button type="button" className="absolute inset-0 bg-black/20" onClick={() => setMobileOpen(false)} aria-label="Close navigation backdrop" />
          <div className="relative">{sidebar}</div>
        </div>
      )}

      <div className="flex min-h-screen">
        <div className="hidden lg:block">{sidebar}</div>
        <main className="min-w-0 flex-1 overflow-auto pt-14 lg:pt-0">{children}</main>
      </div>
    </div>
  );
}
