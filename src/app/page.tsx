"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, FolderKanban, RefreshCw, ShieldCheck } from "lucide-react";

interface Asset {
  id: string;
  canonical_name: string;
  slug?: string;
  asset_kind: string;
  sector?: string | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

interface ReviewItem {
  run_id: string;
  asset_id?: string;
  asset_name: string;
  run_type: string;
  priority: string | null;
}

function formatKind(kind: string) {
  return kind.replace(/_asset/g, "").replace(/_/g, " ");
}

function formatDate(value?: string) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "No activity yet"
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export default function HomePage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [assetsRes, queueRes] = await Promise.all([
          fetch("/api/assets", { signal: controller.signal }),
          fetch("/api/review/queue", { signal: controller.signal }),
        ]);
        const assetsData = await assetsRes.json().catch(() => []);
        const queueData = await queueRes.json().catch(() => []);
        if (!assetsRes.ok) throw new Error(assetsData?.error || "Unable to load assets");
        if (!queueRes.ok) throw new Error(queueData?.error || "Unable to load review queue");
        setAssets(Array.isArray(assetsData) ? assetsData : []);
        setQueue(Array.isArray(queueData) ? queueData : []);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load the workspace");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [reloadToken]);

  const recentAssets = useMemo(
    () =>
      [...assets]
        .sort((a, b) => {
          const left = new Date(a.updated_at || a.created_at || 0).getTime();
          const right = new Date(b.updated_at || b.created_at || 0).getTime();
          return right - left;
        })
        .slice(0, 8),
    [assets],
  );
  const reviewCountLabel = queue.length >= 50 ? "50+" : String(queue.length);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-7 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-gray-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-gray-400">
            <span>Kintsugi OS</span>
            <span>/</span>
            <span className="text-gray-600">Home</span>
          </div>
          <h1 className="text-[26px] font-bold tracking-tight text-black">Continue research</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray-500">
            Pick up an asset workspace or resolve the next decision waiting for you.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/assets"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-[12px] font-bold text-gray-700 shadow-sm transition-colors hover:border-gray-300 hover:text-black"
          >
            <FolderKanban size={14} />
            Asset catalog
          </Link>
          <Link
            href="/review"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-black px-3 text-[12px] font-bold text-white shadow-sm transition-colors hover:bg-black/90"
          >
            <ShieldCheck size={14} />
            Review queue
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-semibold text-gray-500" aria-live="polite">
        <span>{loading ? "Loading workspace…" : `${assets.length} ${assets.length === 1 ? "asset" : "assets"}`}</span>
        <span className="h-1 w-1 rounded-full bg-gray-300" aria-hidden="true" />
        <span>{loading ? "" : `${reviewCountLabel} ${queue.length === 1 ? "review" : "reviews"} waiting`}</span>
        {!loading && !error && <span className="text-gray-400">Latest update {formatDate(recentAssets[0]?.updated_at || recentAssets[0]?.created_at)}</span>}
      </div>

      {error ? (
        <div className="flex flex-col gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-4 text-[13px] text-red-700 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setReloadToken((value) => value + 1)}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-3 text-[11px] font-bold text-red-700 hover:border-red-300"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-md border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5 sm:px-5">
              <div>
                <h2 className="text-[15px] font-bold text-black">Asset workspaces</h2>
                <p className="mt-0.5 text-[12px] text-gray-400">Most recently updated research targets.</p>
              </div>
              <Link href="/assets" className="inline-flex items-center gap-1.5 text-[12px] font-bold text-gray-600 hover:text-black">
                View all <ArrowRight size={14} />
              </Link>
            </div>

            {loading ? (
              <div className="space-y-3 px-4 py-5 sm:px-5" aria-label="Loading assets">
                {[1, 2, 3].map((item) => <div key={item} className="h-12 animate-pulse rounded-md bg-gray-100" />)}
              </div>
            ) : recentAssets.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <FolderKanban className="mx-auto mb-3 text-gray-300" size={28} />
                <p className="text-[13px] font-semibold text-gray-500">No assets indexed yet.</p>
                <Link href="/assets" className="mt-3 inline-flex text-[12px] font-bold text-black underline underline-offset-4">Open catalog</Link>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentAssets.map((asset) => (
                  <Link
                    key={asset.id}
                    href={`/assets/${asset.id}/research/general`}
                    className="grid gap-2 px-4 py-3.5 transition-colors hover:bg-[#fbfcfd] sm:grid-cols-[minmax(0,1fr)_150px_110px] sm:items-center sm:px-5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-bold text-black">{asset.canonical_name}</div>
                      <div className="mt-0.5 truncate text-[12px] text-gray-400">{asset.sector || "General market research"}</div>
                    </div>
                    <span className="w-fit rounded-full border border-gray-200 bg-[#fbfcfd] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-600">
                      {formatKind(asset.asset_kind)}
                    </span>
                    <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-gray-400 sm:justify-end">
                      <span>{formatDate(asset.updated_at || asset.created_at)}</span>
                      <ArrowRight size={14} className="text-gray-400" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <aside className="rounded-md border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5">
              <div>
                <h2 className="text-[15px] font-bold text-black">Needs your review</h2>
                <p className="mt-0.5 text-[12px] text-gray-400">Completed runs waiting for a decision.</p>
              </div>
              <ShieldCheck size={16} className="text-gray-400" />
            </div>
            {loading ? (
              <div className="space-y-3 px-4 py-5" aria-label="Loading review queue">
                {[1, 2].map((item) => <div key={item} className="h-10 animate-pulse rounded-md bg-gray-100" />)}
              </div>
            ) : queue.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12px] text-gray-400">No open review gates.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {queue.slice(0, 5).map((item) => (
                  <Link
                    key={item.run_id}
                    href={`/review?run=${item.run_id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[#fbfcfd]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-bold text-black">{item.asset_name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-gray-400">{formatKind(item.run_type)}{item.priority ? ` · ${item.priority} priority` : ""}</span>
                    </span>
                    <ArrowRight size={14} className="shrink-0 text-gray-400" />
                  </Link>
                ))}
                {queue.length > 5 && (
                  <Link href="/review" className="block px-4 py-3 text-[11px] font-bold text-gray-600 hover:text-black">View all {queue.length} reviews</Link>
                )}
              </div>
            )}
          </aside>
        </section>
      )}
    </div>
  );
}
