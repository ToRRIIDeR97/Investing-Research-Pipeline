"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, Boxes, Building2, Coins, Folder, RefreshCw, Search, SlidersHorizontal } from "lucide-react";

interface Asset {
  id: string;
  canonical_name: string;
  slug: string;
  asset_kind: string;
  sector: string | null;
  status: string;
  created_at?: string;
  updated_at?: string;
}

const filters = [
  { value: "", label: "All", icon: Boxes },
  { value: "equity", label: "Equity", icon: Building2 },
  { value: "crypto_asset", label: "Crypto", icon: Coins },
  { value: "commodity", label: "Commodity", icon: SlidersHorizontal },
];

function formatKind(kind: string) {
  return kind.replace(/_asset/g, "").replace(/_/g, " ");
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function statusClass(status?: string) {
  const value = (status || "active").toLowerCase();
  if (["failed", "error", "blocked"].some((item) => value.includes(item))) return "border-red-200 bg-red-50 text-red-700";
  if (["waiting", "review", "pending"].some((item) => value.includes(item))) return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-gray-200 bg-[#fbfcfd] text-gray-600";
}

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"updated" | "name" | "status">("updated");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function fetchAssets() {
      setLoading(true);
      setError(null);
      try {
        const url = filter ? `/api/assets?kind=${encodeURIComponent(filter)}` : "/api/assets";
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json().catch(() => []);
        if (!response.ok) throw new Error(data?.error || "Unable to load asset catalog");
        setAssets(Array.isArray(data) ? data : []);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load asset catalog");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    fetchAssets();
    return () => controller.abort();
  }, [filter, reloadToken]);

  const filteredAssets = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const matches = assets.filter((asset) => {
      if (!query) return true;
      return [asset.canonical_name, asset.slug, asset.asset_kind, asset.sector || "", asset.status].some((value) => value.toLowerCase().includes(query));
    });
    return matches.sort((a, b) => {
      if (sortBy === "name") return a.canonical_name.localeCompare(b.canonical_name);
      if (sortBy === "status") return a.status.localeCompare(b.status) || a.canonical_name.localeCompare(b.canonical_name);
      return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
    });
  }, [assets, searchQuery, sortBy]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-5 py-7 lg:px-8">
      <header className="flex flex-col gap-3 border-b border-gray-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-gray-400">
            <span>Workspace</span><span>/</span><span className="text-gray-600">Assets</span>
          </div>
          <h1 className="text-[26px] font-bold tracking-tight text-black">Asset catalog</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray-500">Open a research workspace, filter the registry, or find an asset by name, sector, or status.</p>
        </div>
        <div className="font-mono text-[11px] text-gray-400" aria-live="polite">
          {loading ? "Loading records…" : `${filteredAssets.length} of ${assets.length} records`}
        </div>
      </header>

      <div className="flex flex-col gap-3 rounded-md border border-gray-200 bg-white p-3 shadow-sm lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={16} aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search name, ticker slug, sector, or status"
            aria-label="Search assets"
            className="h-10 w-full rounded-md border border-gray-200 bg-[#fbfcfd] pl-10 pr-3 font-mono text-[12px] text-black outline-none transition-colors focus:border-gray-400"
          />
        </div>
        <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="Filter asset type">
          {filters.map((item) => {
            const Icon = item.icon;
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setFilter(item.value)}
                aria-pressed={active}
                className={["inline-flex h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-[12px] font-bold transition-colors", active ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-black"].join(" ")}
              >
                <Icon size={14} aria-hidden="true" />{item.label}
              </button>
            );
          })}
        </div>
        <label className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-[11px] font-bold text-gray-600">
          <ArrowUpDown size={14} aria-hidden="true" />
          <span className="sr-only">Sort assets</span>
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} className="bg-transparent font-mono text-[11px] text-gray-700 outline-none">
            <option value="updated">Recently updated</option>
            <option value="name">Name</option>
            <option value="status">Status</option>
          </select>
        </label>
      </div>

      {error ? (
        <div className="flex flex-col gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-4 text-[13px] text-red-700 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadToken((value) => value + 1)} className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-3 text-[11px] font-bold text-red-700 hover:border-red-300"><RefreshCw size={13} />Retry</button>
        </div>
      ) : loading ? (
        <div className="space-y-2 rounded-md border border-gray-200 bg-white p-4 shadow-sm" aria-label="Loading asset catalog">
          {[1, 2, 3, 4].map((item) => <div key={item} className="h-12 animate-pulse rounded-md bg-gray-100" />)}
        </div>
      ) : filteredAssets.length === 0 ? (
        <div className="rounded-md border border-gray-200 bg-white py-16 text-center shadow-sm">
          <Folder className="mx-auto mb-3 text-gray-300" size={32} />
          <p className="text-[14px] font-bold text-gray-600">No matching assets</p>
          <p className="mt-1 text-[12px] text-gray-400">Adjust the search or asset-type filter.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[680px] text-left">
              <thead className="border-b border-gray-100 bg-[#fbfcfd] text-[10px] font-bold uppercase tracking-wider text-gray-400">
                <tr><th className="px-4 py-3 font-bold">Asset</th><th className="px-4 py-3 font-bold">Type</th><th className="px-4 py-3 font-bold">Sector</th><th className="px-4 py-3 font-bold">Status</th><th className="px-4 py-3 font-bold">Updated</th><th className="px-4 py-3" /></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredAssets.map((asset) => (
                  <tr key={asset.id} className="group hover:bg-[#fbfcfd]">
                    <td className="px-4 py-3"><Link href={`/assets/${asset.id}/research/general`} className="block min-w-0"><span className="block truncate text-[13px] font-bold text-black group-hover:underline group-hover:underline-offset-4">{asset.canonical_name}</span><span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-wider text-gray-400">{asset.slug}</span></Link></td>
                    <td className="px-4 py-3 text-[11px] font-semibold capitalize text-gray-600">{formatKind(asset.asset_kind)}</td>
                    <td className="px-4 py-3 text-[12px] text-gray-500">{asset.sector || "General market"}</td>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold capitalize ${statusClass(asset.status)}`}>{asset.status || "active"}</span></td>
                    <td className="px-4 py-3 font-mono text-[10px] text-gray-400">{formatDate(asset.updated_at || asset.created_at)}</td>
                    <td className="px-4 py-3 text-right"><Link href={`/assets/${asset.id}/research/general`} aria-label={`Open ${asset.canonical_name}`} className="text-gray-400 hover:text-black"><ArrowUpDown size={14} className="rotate-90" /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-gray-100 md:hidden">
            {filteredAssets.map((asset) => (
              <Link key={asset.id} href={`/assets/${asset.id}/research/general`} className="block px-4 py-3.5 hover:bg-[#fbfcfd]">
                <div className="flex items-start justify-between gap-3"><span className="min-w-0 truncate text-[14px] font-bold text-black">{asset.canonical_name}</span><ArrowUpDown size={14} className="shrink-0 rotate-90 text-gray-400" /></div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500"><span className="font-mono uppercase tracking-wider text-gray-400">{asset.slug}</span><span>{formatKind(asset.asset_kind)}</span><span>{asset.sector || "General market"}</span><span className={`rounded-full border px-2 py-0.5 font-bold capitalize ${statusClass(asset.status)}`}>{asset.status || "active"}</span></div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
