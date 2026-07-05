"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  Building2,
  Coins,
  Folder,
  Search,
  SlidersHorizontal,
} from "lucide-react";

interface Asset {
  id: string;
  canonical_name: string;
  slug: string;
  asset_kind: string;
  sector: string | null;
  status: string;
  created_at: string;
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

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    async function fetchAssets() {
      setLoading(true);
      try {
        const url = filter ? `/api/assets?kind=${filter}` : "/api/assets";
        const res = await fetch(url);
        const data = await res.json();
        setAssets(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error("Failed to fetch assets:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchAssets();
  }, [filter]);

  const filteredAssets = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return assets;

    return assets.filter((asset) =>
      [
        asset.canonical_name,
        asset.slug,
        asset.asset_kind,
        asset.sector || "",
        asset.status,
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [assets, searchQuery]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-7 lg:px-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-gray-400">
            <span>Projects</span>
            <span>/</span>
            <span className="text-gray-600">Overview</span>
          </div>
          <h1 className="text-[26px] font-bold tracking-tight text-black">Asset catalog</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray-500">
            Browse tracked research targets, inspect their workspace archive, or launch a fresh research run.
          </p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Visible records</div>
          <div className="mt-1 font-mono text-[20px] font-bold text-black">
            {loading ? "..." : filteredAssets.length.toString().padStart(3, "0")}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-gray-200 bg-white p-3 shadow-sm lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search name, ticker slug, sector, or status"
            className="h-10 w-full rounded-md border border-gray-200 bg-[#fbfcfd] pl-10 pr-3 font-mono text-[12px] text-black outline-none transition-colors focus:border-gray-300"
          />
        </div>

        <div className="flex gap-1.5 overflow-x-auto">
          {filters.map((item) => {
            const Icon = item.icon;
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setFilter(item.value)}
                className={[
                  "inline-flex h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-[12px] font-bold transition-colors",
                  active
                    ? "border-black bg-black text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-black",
                ].join(" ")}
              >
                <Icon size={14} />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="rounded-md border border-gray-200 bg-white py-16 text-center font-mono text-[12px] text-gray-400 shadow-sm">
          Loading asset catalog...
        </div>
      ) : filteredAssets.length === 0 ? (
        <div className="rounded-md border border-gray-200 bg-white py-16 text-center shadow-sm">
          <Folder className="mx-auto mb-3 text-gray-300" size={32} />
          <p className="text-[14px] font-bold text-gray-600">No matching projects</p>
          <p className="mt-1 text-[12px] text-gray-400">Adjust the search or asset-type filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredAssets.map((asset) => (
            <Link
              key={asset.id}
              href={`/assets/${asset.id}/view`}
              className="group relative block rounded-md border border-gray-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md"
            >
              <div className="absolute left-4 top-[-7px] h-2.5 w-14 rounded-t-md border-x border-t border-gray-200 bg-white group-hover:border-gray-300" />
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-bold text-black">{asset.canonical_name}</div>
                  <div className="mt-1 truncate font-mono text-[11px] uppercase tracking-wider text-gray-400">
                    {asset.slug}
                  </div>
                </div>
                <span className="shrink-0 rounded-full border border-gray-200 bg-[#fbfcfd] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-600">
                  {formatKind(asset.asset_kind)}
                </span>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Sector</div>
                  <div className="mt-1 truncate text-[12px] font-semibold text-gray-700">{asset.sector || "General market"}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Status</div>
                  <div className="mt-1 truncate text-[12px] font-semibold capitalize text-gray-700">{asset.status || "active"}</div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4 text-[12px] font-bold text-gray-500">
                <span>Open workspace</span>
                <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
