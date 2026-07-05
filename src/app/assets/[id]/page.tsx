"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  MetricHistoryChart,
  ValuationSignalChart,
  ResearchCostChart,
  PipelineProgressChart,
} from "@/components/charts";

interface AssetDetail {
  id: string;
  canonical_name: string;
  slug: string;
  asset_kind: string;
  sector: string | null;
  industry: string | null;
  description: string | null;
  status: string;
  base_currency: string | null;
  home_country: string | null;
  primary_profile_id: string | null;
  profile_name: string | null;
  listings?: { symbol: string; exchange: string | null; is_primary: boolean }[];
}

interface ResearchRun {
  id: string;
  run_type: string;
  status: string;
  research_question: string | null;
  created_at: string;
  completed_at: string | null;
}

interface MetricPoint {
  period: string;
  value: number;
  metric_name: string;
  unit?: string;
  currency?: string;
}

interface ValuationSignalData {
  signal_name: string;
  signal: string;
  cheapness_score: number | null;
  current_value: number | null;
  lens_family: string;
}

interface CostSlice {
  tier: string;
  cost: number;
  calls: number;
}

interface StageInfo {
  stage_key: string;
  status: string;
  stage_order: number;
}

export default function AssetDetailPage() {
  const params = useParams();
  const assetId = params.id as string;

  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [metrics, setMetrics] = useState<MetricPoint[]>([]);
  const [signals, setSignals] = useState<ValuationSignalData[]>([]);
  const [costData, setCostData] = useState<CostSlice[]>([]);
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [assetRes, runsRes, metricsRes, signalsRes, costRes, stagesRes] =
          await Promise.all([
            fetch(`/api/assets/${assetId}`),
            fetch(`/api/assets/${assetId}/research-runs`),
            fetch(`/api/assets/${assetId}/metrics`),
            fetch(`/api/assets/${assetId}/valuation-signals`),
            fetch(`/api/assets/${assetId}/research-cost`),
            fetch(`/api/assets/${assetId}/pipeline-stages`),
          ]);
        if (assetRes.ok && runsRes.ok) {
          const assetData = await assetRes.json();
          const runsData = await runsRes.json();
          setAsset(assetData);
          setRuns(runsData);
        }
        if (metricsRes.ok) setMetrics(await metricsRes.json());
        if (signalsRes.ok) setSignals(await signalsRes.json());
        if (costRes.ok) setCostData(await costRes.json());
        if (stagesRes.ok) setStages(await stagesRes.json());
      } catch (error) {
        console.error("Failed to load asset details:", error);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [assetId]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f4f7fa] font-mono text-[13px] text-gray-500">
        Loading project metadata...
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f4f7fa] font-mono text-red-500">
        Project profile not found.
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-400 mb-2">
        <span>Projects</span>
        <span>&rsaquo;</span>
        <span className="text-gray-500 font-semibold">{asset.canonical_name}</span>
      </div>

      {/* Asset Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-xl font-bold tracking-tight text-black">{asset.canonical_name}</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              asset.asset_kind === "equity"
                ? "bg-blue-50 text-blue-700"
                : "bg-orange-50 text-orange-700"
            }`}
          >
            {asset.asset_kind.replace(/_asset/g, "")}
          </span>
          {asset.listings && asset.listings.length > 0 && (
            <span className="text-xs font-mono text-gray-400">
              {asset.listings.find((l) => l.is_primary)?.symbol || asset.listings[0].symbol}
              {asset.listings.find((l) => l.is_primary)?.exchange
                ? ` · ${asset.listings.find((l) => l.is_primary)?.exchange}`
                : ""}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400">
          {asset.sector || "General Market"}
          {asset.industry ? ` · ${asset.industry}` : ""}
          {asset.home_country ? ` · ${asset.home_country}` : ""}
        </p>
        {asset.description && (
          <p className="mt-3 text-[13px] text-gray-500 max-w-2xl leading-relaxed">
            {asset.description}
          </p>
        )}
      </div>

      {/* Actions (Launch View/Run) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Link
          href={`/assets/${assetId}/run`}
          className="relative group block rounded-[16px] border border-gray-200 bg-white p-6 pt-8 hover:translate-y-[-2px] hover:shadow-sm hover:border-gray-300 transition-all text-left"
        >
          <div className="absolute top-[-7px] left-4 h-2.5 w-14 rounded-t-md bg-white border-t border-x border-gray-200 group-hover:border-gray-300" />
          <div className="text-gray-400 mb-2.5">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
          </div>
          <h3 className="font-bold text-[14px] text-black group-hover:text-blue-600 transition-colors">
            Run Research
          </h3>
          <p className="text-xs text-gray-400 mt-1 leading-normal">
            Start, continue, or check in on an AI-led pipeline orchestration.
          </p>
        </Link>

        <Link
          href={`/assets/${assetId}/view`}
          className="relative group block rounded-[16px] border border-gray-200 bg-white p-6 pt-8 hover:translate-y-[-2px] hover:shadow-sm hover:border-gray-300 transition-all text-left"
        >
          <div className="absolute top-[-7px] left-4 h-2.5 w-14 rounded-t-md bg-white border-t border-x border-gray-200 group-hover:border-gray-300" />
          <div className="text-gray-400 mb-2.5">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <h3 className="font-bold text-[14px] text-black group-hover:text-blue-600 transition-colors">
            View Research Archive
          </h3>
          <p className="text-xs text-gray-400 mt-1 leading-normal">
            Browse ingested papers, DCF sheets, evidence models, and final memos.
          </p>
        </Link>
      </div>

      {/* Properties Cards grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Research Runs</p>
          <p className="mt-1 text-xl font-bold text-black">{runs.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Last Run Date</p>
          <p className="mt-1 text-[13px] font-semibold text-black leading-tight">
            {runs.length > 0
              ? new Date(runs[0].created_at).toLocaleDateString()
              : "Never"}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Status</p>
          <p className="mt-1 text-[13px] font-semibold text-black uppercase tracking-wider">{asset.status}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Assigned Profile</p>
          <p className="mt-1 text-[13px] font-semibold text-black leading-tight">
            {asset.profile_name || "General Standard"}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Currency</p>
          <p className="mt-1 text-[13px] font-semibold text-black font-mono">{asset.base_currency || "—"}</p>
        </div>
      </div>

      {/* Research Dashboard — Charts */}
      <div className="mb-8">
        <h3 className="font-bold text-[14px] text-black mb-4">Research Dashboard</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Metric History */}
          <div className="rounded-[16px] border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[12px] font-bold text-black uppercase tracking-wider">
                Metric History
              </h4>
              <span className="text-[10px] text-gray-400 font-mono">
                {metrics.length} observations
              </span>
            </div>
            <MetricHistoryChart data={metrics} />
          </div>

          {/* Valuation Signals */}
          <div className="rounded-[16px] border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[12px] font-bold text-black uppercase tracking-wider">
                Valuation Signals
              </h4>
              <span className="text-[10px] text-gray-400 font-mono">
                {signals.length} signals
              </span>
            </div>
            <ValuationSignalChart data={signals} />
          </div>

          {/* Research Cost */}
          <div className="rounded-[16px] border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[12px] font-bold text-black uppercase tracking-wider">
                Research Cost
              </h4>
              <span className="text-[10px] text-gray-400 font-mono">
                by model tier
              </span>
            </div>
            <ResearchCostChart data={costData} />
          </div>

          {/* Pipeline Progress */}
          <div className="rounded-[16px] border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[12px] font-bold text-black uppercase tracking-wider">
                Pipeline Progress
              </h4>
              <span className="text-[10px] text-gray-400 font-mono">
                latest run
              </span>
            </div>
            <PipelineProgressChart data={stages} />
          </div>
        </div>
      </div>

      {/* Recent Runs list */}
      {runs.length > 0 && (
        <div className="rounded-[16px] border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="font-bold text-[14px] text-black border-b border-gray-100 pb-3 mb-4">
            Recent Research Runs
          </h3>
          <div className="space-y-2">
            {runs.slice(0, 5).map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between rounded-xl border border-gray-100/60 bg-[#fbfcfd] px-4 py-3 hover:border-gray-200 transition-all"
              >
                <div>
                  <span className="text-[13px] font-semibold text-black block leading-snug">
                    {run.run_type.replace(/_/g, " ")}
                  </span>
                  {run.research_question && (
                    <p className="text-[11.5px] text-gray-400 mt-0.5 truncate max-w-md">
                      {run.research_question}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                      run.status === "completed"
                        ? "bg-green-50 text-green-700"
                        : "bg-yellow-50 text-yellow-700"
                    }`}
                  >
                    {run.status}
                  </span>
                  <span className="text-[11px] text-gray-400 font-mono">
                    {new Date(run.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
