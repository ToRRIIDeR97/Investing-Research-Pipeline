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
    return <p className={`${ui.banner} ${ui.muted}`} role="status">Monitor check {checked}: {outcome}.{monitor.status !== "current" && monitor.reasons[0] ? ` ${monitor.reasons[0]}` : ""}</p>;
  }
  return <section className={`${ui.tile} mb-4`} role="status" aria-label="Refresh due">
    <div className={ui.tileHead}><h2>Refresh due</h2><span className={ui.muted}>Monitor check {checked}</span></div>
    <div className={ui.tileBody}><ul>{monitor.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    <p className={ui.muted}>{monitor.newer_run ? "A newer run of this asset already exists." : "A new run builds on the last completed run and reports what changed. Nothing starts automatically."}</p></div>
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
  const words = (value: string) => value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  return <div className={`${ui.page} ${ui.withBack}`}>
    <Link href={`/assets/${assetId}/view`} className={ui.back}><ArrowLeft size={14} />Research brief</Link>
    <header className={ui.heading}>
      <div className={ui.titleGroup}><h1>{asset.canonical_name}</h1><span className={ui.muted}>{listing?.symbol || asset.asset_kind.replace(/_asset/g, "")}</span></div>
      <div className={ui.headActions}>
        <Link href={`/assets/${assetId}/view`} className={ui.secondary}>Read research</Link>
        <Link href={`/assets/${assetId}/run`} className={ui.primary}>{runs.length ? "Open run" : "Start research"}</Link>
      </div>
    </header>
    {monitor && <MonitorStatus monitor={monitor} />}
    <div className={ui.grid}>
      <section className={`${ui.tile} ${ui.s7}`}>
        <div className={ui.tileHead}><h2>Asset details</h2></div>
        {asset.description && <p className={`${ui.tileBody} ${ui.muted}`}>{asset.description}</p>}
        <dl className={`${ui.metadata} px-3.5 pb-3`}>
          {[["Sector", asset.sector], ["Industry", asset.industry], ["Country", asset.home_country], ["Currency", asset.base_currency], ["Profile", asset.profile_name], ["Status", asset.status ? words(asset.status) : null], ["Exchange", listing?.exchange], ["Last run", runs[0] ? new Date(runs[0].created_at).toLocaleDateString() : "None"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not set"}</dd></div>)}
        </dl>
      </section>
      <section className={`${ui.tile} ${ui.s5}`}>
        <div className={ui.tileHead}><h2>Pipeline progress</h2></div>
        <div className={ui.tileBody}><PipelineProgressChart data={stages} /></div>
      </section>
      <section className={`${ui.tile} ${ui.s6}`}><div className={ui.tileHead}><h2>Metrics</h2></div><div className={ui.chart}><MetricHistoryChart data={metrics} /></div></section>
      <section className={`${ui.tile} ${ui.s6}`}><div className={ui.tileHead}><h2>Valuation signals</h2></div><div className={ui.chart}><ValuationSignalChart data={signals} /></div></section>
      <section className={`${ui.tile} ${ui.s6}`}><div className={ui.tileHead}><h2>Research cost</h2></div><div className={ui.chart}><ResearchCostChart data={costData} /></div></section>
      <section className={`${ui.tile} ${ui.s6}`}>
        <div className={ui.tileHead}><h2>Run history</h2><span className={ui.muted}>{runs.length}</span></div>
        {runs.length ? <div className={ui.table}><table><thead><tr><th>Run</th><th>Started</th><th>Id</th><th>Status</th></tr></thead><tbody>
          {runs.map((run) => <tr key={run.id}><td><Link href={`/assets/${assetId}/run?run=${run.id}`} className="font-medium hover:underline">{words(run.run_type)}</Link></td><td>{new Date(run.created_at).toLocaleDateString()}</td><td className={ui.mono}>{run.id.slice(0, 8)}</td><td><span className={ui.status} data-status={run.status}>{words(run.status)}</span></td></tr>)}
        </tbody></table></div> : <p className={ui.empty}>No research runs yet.</p>}
      </section>
      <section className={`${ui.tile} ${ui.s12}`}>
        <div className={ui.tileHead}><h2>Backtests</h2><span className={ui.muted}>{backtests.length}</span></div>
        {!backtests.length ? <p className={ui.empty}>No backtests for the latest run.</p> : <div className={ui.table}><table>
          <thead><tr><th>Strategy</th><th>Symbol</th><th>Benchmark</th><th>Status</th><th className={ui.num}>Return</th><th className={ui.num}>Sharpe</th><th className={ui.num}>Drawdown</th><th className={ui.num}>Trades</th><th className={ui.num}><span className="sr-only">Artifacts</span></th></tr></thead>
          <tbody>{backtests.map((test) => <tr key={test.id}>
            <td><div className="font-medium">{test.strategy_name || "Backtest"}</div><div className={ui.rowMeta}>{test.error_message || test.strategy_prompt}</div></td>
            <td>{test.symbol}</td><td>{test.benchmark_symbol || "—"}</td><td><span className={ui.status} data-status={test.status}>{words(test.status)}</span></td>
            <td className={ui.num}>{formatPercent(test.metrics_json?.total_return)}</td><td className={ui.num}>{formatNumber(test.metrics_json?.sharpe)}</td><td className={ui.num}>{formatPercent(test.metrics_json?.max_drawdown)}</td><td className={ui.num}>{formatNumber(test.metrics_json?.trade_count, 0)}</td>
            <td className={ui.num}><Link href={`/api/backtests/${test.id}/artifacts`} className={ui.textLink}>Artifacts<ArrowUpRight size={13} /></Link></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </div>
  </div>;
}
