"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import ui from "@/components/research-ui.module.css";
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

interface BacktestRun {
  id: string;
  status: string;
  strategy_name: string | null;
  strategy_prompt: string;
  symbol: string;
  benchmark_symbol: string | null;
  metrics_json: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

interface MonitorCheck {
  status: string;
  refresh_due: boolean;
  reasons: string[];
  checked_at: string;
  newer_run: boolean;
}

function MonitorStatus({ monitor }: { monitor: MonitorCheck }) {
  const checked = new Date(monitor.checked_at).toLocaleDateString();
  if (!monitor.refresh_due) {
    const outcome = monitor.status === "current" ? "no refresh due" : monitor.status === "skipped" ? "not checked" : "check failed";
    return <p className={ui.muted} role="status">Monitor check {checked}: {outcome}.{monitor.status !== "current" && monitor.reasons[0] ? ` ${monitor.reasons[0]}` : ""}</p>;
  }
  return <section className={ui.notice} role="status" aria-label="Refresh due">
    <strong>Refresh due</strong> (monitor check {checked})
    <ul>{monitor.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    <p>{monitor.newer_run ? "A newer run of this asset already exists." : "A new run builds on the last completed run and reports what changed. Nothing starts automatically."}</p>
  </section>;
}

function formatPercent(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: unknown, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
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
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [monitor, setMonitor] = useState<MonitorCheck | null>(null);

  // The stored monitor-check result; the check itself runs from npm run monitor:check, never from this page.
  useEffect(() => {
    fetch(`/api/assets/${assetId}/monitor`).then((res) => res.ok ? res.json() : null).then(setMonitor).catch(() => setMonitor(null));
  }, [assetId]);

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
        if (!assetRes.ok || !runsRes.ok) throw new Error("Unable to load asset details.");
        if (assetRes.ok && runsRes.ok) {
          const assetData = await assetRes.json();
          const runsData = await runsRes.json();
          const sortedRuns = Array.isArray(runsData)
            ? [...runsData].sort(
                (a, b) =>
                  new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
              )
            : [];
          setAsset(assetData);
          setRuns(sortedRuns);

          if (sortedRuns[0]) {
            const backtestsRes = await fetch(
              `/api/research-runs/${sortedRuns[0].id}/backtests`
            );
            if (backtestsRes.ok) {
              setBacktests(await backtestsRes.json());
            }
          }
        }
        if (metricsRes.ok) setMetrics(await metricsRes.json());
        if (signalsRes.ok) setSignals(await signalsRes.json());
        if (costRes.ok) setCostData(await costRes.json());
        if (stagesRes.ok) setStages(await stagesRes.json());
      } catch (error) {
        setError("Unable to load asset details.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [assetId]);

  if (loading) return <div className={ui.page} role="status">Loading asset…</div>;
  if (!asset) return <div className={ui.page}><p className={ui.error} role="alert">{error || "Asset not found."}</p><Link href="/assets" className={ui.textLink}>Back to research</Link></div>;
  const listing = asset.listings?.find((item) => item.is_primary) || asset.listings?.[0];

  return <div className={`${ui.page} ${ui.withBack}`}>
    <Link href={`/assets/${assetId}/view`} className={ui.back}><ArrowLeft size={17} />Research brief</Link>
    <header className={ui.heading}><h1>{asset.canonical_name}</h1><span className={ui.muted}>{listing?.symbol || asset.asset_kind.replace(/_asset/g, "")}</span></header>
    {asset.description && <p className={ui.lead}>{asset.description}</p>}
    <div className={ui.actions}>
      <Link href={`/assets/${assetId}/view`} className={ui.textLink}>Read research<ArrowUpRight size={16} /></Link>
      <Link href={`/assets/${assetId}/run`} className={ui.primary}>{runs.length ? "Open run" : "Start research"}</Link>
    </div>
    {monitor && <MonitorStatus monitor={monitor} />}
    <details className={ui.section} open><summary>Asset details</summary><dl className={`${ui.metadata} ${ui.sectionBody}`}>
      {[["Sector", asset.sector], ["Industry", asset.industry], ["Country", asset.home_country], ["Currency", asset.base_currency], ["Profile", asset.profile_name], ["Status", asset.status], ["Exchange", listing?.exchange], ["Last run", runs[0] ? new Date(runs[0].created_at).toLocaleDateString() : "None"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not set"}</dd></div>)}
    </dl></details>
    <details className={ui.section}><summary>Metrics</summary><div className={ui.chart}><MetricHistoryChart data={metrics} /></div></details>
    <details className={ui.section}><summary>Valuation signals</summary><div className={ui.chart}><ValuationSignalChart data={signals} /></div></details>
    <details className={ui.section}><summary>Research cost</summary><div className={ui.chart}><ResearchCostChart data={costData} /></div></details>
    <details className={ui.section}><summary>Pipeline progress</summary><div className={ui.sectionBody}><PipelineProgressChart data={stages} /></div></details>
    <details className={ui.section}><summary>Backtests <span className={ui.muted}>{backtests.length}</span></summary>
      <div className={ui.sectionBody}>{!backtests.length ? <p>No backtests for the latest run.</p> : backtests.map((test) => <div key={test.id} className={ui.row}>
        <div><div className={ui.rowTitle}>{test.strategy_name || "Backtest"}</div><p className={ui.rowMeta}>{test.symbol}{test.benchmark_symbol ? ` · ${test.benchmark_symbol}` : ""} · {test.status}</p><p className={ui.rowMeta}>{test.error_message || test.strategy_prompt}</p>
          <p className={ui.rowMeta}>Return {formatPercent(test.metrics_json?.total_return)} · Sharpe {formatNumber(test.metrics_json?.sharpe)} · Drawdown {formatPercent(test.metrics_json?.max_drawdown)} · Trades {formatNumber(test.metrics_json?.trade_count, 0)}</p>
          <Link href={`/api/backtests/${test.id}/artifacts`} className={ui.textLink}>Artifacts<ArrowUpRight size={15} /></Link>
        </div>
      </div>)}</div>
    </details>
    <details className={ui.section}><summary>Run history <span className={ui.muted}>{runs.length}</span></summary><div className={ui.sectionBody}>
      {runs.length ? runs.map((run) => <Link key={run.id} href={`/assets/${assetId}/run?run=${run.id}`} className={ui.row}>
        <div><div className={ui.rowTitle}>{run.run_type.replace(/_/g, " ")}</div><div className={ui.rowMeta}>{new Date(run.created_at).toLocaleDateString()} · {run.id.slice(0, 8)} · {run.status.replace(/_/g, " ")}</div></div><ArrowUpRight size={17} />
      </Link>) : <p>No research runs yet.</p>}
    </div></details>
  </div>;
}
