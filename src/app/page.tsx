"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CircleDollarSign,
  Database,
  FolderKanban,
  ShieldCheck,
  Signal,
  Workflow,
} from "lucide-react";

interface Asset {
  id: string;
  canonical_name: string;
  asset_kind: string;
  sector?: string | null;
  status?: string;
}

interface ReviewItem {
  run_id: string;
  asset_name: string;
  run_type: string;
  priority: string | null;
}

function formatKind(kind: string) {
  return kind.replace(/_asset/g, "").replace(/_/g, " ");
}

export default function HomePage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [assetsRes, queueRes] = await Promise.all([
          fetch("/api/assets"),
          fetch("/api/review/queue"),
        ]);

        if (assetsRes.ok) {
          const data = await assetsRes.json();
          setAssets(Array.isArray(data) ? data : []);
        }
        if (queueRes.ok) {
          const data = await queueRes.json();
          setQueue(Array.isArray(data) ? data : []);
        }
      } catch (error) {
        console.error("Failed to load dashboard metrics:", error);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const assetMix = useMemo(() => {
    return assets.reduce<Record<string, number>>((acc, asset) => {
      acc[asset.asset_kind] = (acc[asset.asset_kind] || 0) + 1;
      return acc;
    }, {});
  }, [assets]);

  const stats = [
    {
      label: "Tracked Assets",
      value: loading ? "..." : assets.length.toString().padStart(3, "0"),
      detail: "Equities, crypto assets, commodities",
      icon: FolderKanban,
    },
    {
      label: "Review Gates",
      value: loading ? "..." : queue.length.toString().padStart(3, "0"),
      detail: "Human decisions awaiting signoff",
      icon: ShieldCheck,
    },
    {
      label: "Pipeline State",
      value: "STABLE",
      detail: "Validators and staging flows online",
      icon: Workflow,
    },
    {
      label: "Evidence Mode",
      value: "LINKED",
      detail: "Claims resolve through source locations",
      icon: Database,
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-5 py-7 lg:px-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-gray-400">
            <span>Kintsugi OS</span>
            <span>/</span>
            <span className="text-gray-600">Home</span>
          </div>
          <h1 className="text-[26px] font-bold tracking-tight text-black">Research command center</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray-500">
            Monitor asset coverage, evidence-backed research runs, review gates, and cost-aware model routing from one workspace.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href="/assets"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-200 bg-white px-4 text-[12px] font-bold text-gray-700 shadow-sm transition-colors hover:border-gray-300 hover:text-black"
          >
            <FolderKanban size={15} />
            Browse Projects
          </Link>
          <Link
            href="/review"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-black px-4 text-[12px] font-bold text-white shadow-sm transition-colors hover:bg-black/90"
          >
            <ShieldCheck size={15} />
            Review Queue
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-md border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400">{stat.label}</div>
                <div className="mt-3 text-2xl font-bold text-black">{stat.value}</div>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-[#fbfcfd] text-gray-500">
                <stat.icon size={17} />
              </div>
            </div>
            <div className="mt-4 text-[12px] text-gray-500">{stat.detail}</div>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_360px]">
        <div className="rounded-md border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="text-[15px] font-bold text-black">Active asset workspaces</h2>
              <p className="mt-0.5 text-[12px] text-gray-400">Recently indexed research targets and operating folders.</p>
            </div>
            <Link href="/assets" className="inline-flex items-center gap-1.5 text-[12px] font-bold text-gray-600 hover:text-black">
              Open catalog <ArrowRight size={14} />
            </Link>
          </div>

          {loading ? (
            <div className="px-5 py-10 text-center font-mono text-[12px] text-gray-400">Loading asset registry...</div>
          ) : assets.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <Database className="mx-auto mb-3 text-gray-300" size={30} />
              <p className="text-[13px] font-semibold text-gray-500">No assets indexed yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {assets.slice(0, 6).map((asset) => (
                <Link
                  key={asset.id}
                  href={`/assets/${asset.id}/view`}
                  className="grid gap-3 px-5 py-4 transition-colors hover:bg-[#fbfcfd] md:grid-cols-[1fr_160px_120px]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-bold text-black">{asset.canonical_name}</div>
                    <div className="mt-1 truncate text-[12px] text-gray-400">{asset.sector || "General market research"}</div>
                  </div>
                  <div className="flex items-center">
                    <span className="rounded-full border border-gray-200 bg-[#fbfcfd] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-600">
                      {formatKind(asset.asset_kind)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] font-bold text-gray-500 md:justify-end md:gap-2">
                    <span>{asset.status || "active"}</span>
                    <ArrowRight size={14} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <aside className="flex flex-col gap-5">
          <div className="rounded-md border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-bold text-black">Coverage Mix</h2>
              <BarChart3 size={17} className="text-gray-400" />
            </div>
            <div className="mt-5 space-y-3">
              {Object.entries(assetMix).length === 0 ? (
                <div className="text-[12px] text-gray-400">No coverage buckets yet.</div>
              ) : (
                Object.entries(assetMix).map(([kind, count]) => {
                  const width = assets.length ? Math.max(10, Math.round((count / assets.length) * 100)) : 0;
                  return (
                    <div key={kind}>
                      <div className="mb-1.5 flex justify-between text-[12px]">
                        <span className="font-semibold capitalize text-gray-600">{formatKind(kind)}</span>
                        <span className="font-mono text-gray-400">{count}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                        <div className="h-full rounded-full bg-black" style={{ width: `${width}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="rounded-md border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-bold text-black">Runtime Signals</h2>
              <Signal size={17} className="text-gray-400" />
            </div>
            <div className="mt-4 space-y-3 text-[12px]">
              <div className="flex items-center justify-between rounded-md border border-gray-100 bg-[#fbfcfd] px-3 py-2.5">
                <span className="text-gray-500">Budget ledger</span>
                <span className="font-bold text-black">enforced</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-gray-100 bg-[#fbfcfd] px-3 py-2.5">
                <span className="text-gray-500">Parser path</span>
                <span className="font-bold text-black">hardened</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-gray-100 bg-[#fbfcfd] px-3 py-2.5">
                <span className="text-gray-500">Premium calls</span>
                <span className="inline-flex items-center gap-1.5 font-bold text-black">
                  <CircleDollarSign size={13} />
                  gated
                </span>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
