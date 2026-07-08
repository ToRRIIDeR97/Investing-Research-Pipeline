"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Brain,
  CheckCircle2,
  CircleDollarSign,
  Database,
  FileText,
  Gauge,
  ListChecks,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import {
  Bar,
  BarChart as ReBarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type JsonRecord = Record<string, unknown>;
type ResearchRecord = Record<string, any>;

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
}

interface ResearchData {
  asset: AssetDetail | null;
  runs: ResearchRecord[];
  activeRun: ResearchRecord | null;
  runDetail: ResearchRecord | null;
  evidence: ResearchRecord[];
  metrics: ResearchRecord[];
  signals: ResearchRecord[];
  scenarios: ResearchRecord[];
  theses: ResearchRecord[];
  risks: ResearchRecord[];
  catalysts: ResearchRecord[];
  backtests: ResearchRecord[];
  sources: ResearchRecord[];
  modelCalls: ResearchRecord[];
}

const emptyResearchData: ResearchData = {
  asset: null,
  runs: [],
  activeRun: null,
  runDetail: null,
  evidence: [],
  metrics: [],
  signals: [],
  scenarios: [],
  theses: [],
  risks: [],
  catalysts: [],
  backtests: [],
  sources: [],
  modelCalls: [],
};

const tabs = [
  { id: "overview", label: "Overview", icon: BookOpen },
  { id: "evidence", label: "Evidence", icon: ListChecks },
  { id: "metrics", label: "Metrics", icon: BarChart3 },
  { id: "valuation", label: "Valuation", icon: CircleDollarSign },
  { id: "thesis", label: "Thesis", icon: Brain },
  { id: "backtests", label: "Backtests", icon: Gauge },
  { id: "sources", label: "Sources", icon: Database },
] as const;

type TabId = (typeof tabs)[number]["id"];

const signalColors: Record<string, string> = {
  very_cheap: "#047857",
  cheap: "#10b981",
  neutral: "#64748b",
  expensive: "#f59e0b",
  very_expensive: "#dc2626",
  inconclusive: "#94a3b8",
  not_applicable: "#cbd5e1",
};

export default function ViewResearchPage() {
  const params = useParams();
  const assetId = String(params.id);
  const [data, setData] = useState<ResearchData>(emptyResearchData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    void loadResearch();
  }, [assetId]);

  async function loadResearch() {
    setLoading(true);
    setError(null);

    try {
      const [asset, runs] = await Promise.all([
        fetchJson<AssetDetail | null>(`/api/assets/${assetId}`, null),
        fetchJson<ResearchRecord[]>(`/api/assets/${assetId}/research-runs`, []),
      ]);

      const sortedRuns = [...runs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      const activeRun =
        sortedRuns.find((run) => run.status === "completed") ?? sortedRuns[0] ?? null;

      if (!activeRun) {
        setData({ ...emptyResearchData, asset, runs: sortedRuns });
        return;
      }

      const runId = activeRun.id;
      const [
        runDetail,
        evidence,
        metrics,
        signals,
        scenarios,
        theses,
        risks,
        catalysts,
        backtests,
        sources,
        modelCalls,
      ] = await Promise.all([
        fetchJson<ResearchRecord | null>(`/api/research-runs/${runId}`, null),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/evidence`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/metrics`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/valuation-signals`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/scenarios`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/thesis`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/risks`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/catalysts`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/backtests`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/sources`, []),
        fetchJson<ResearchRecord[]>(`/api/research-runs/${runId}/model-calls`, []),
      ]);

      setData({
        asset,
        runs: sortedRuns,
        activeRun,
        runDetail,
        evidence,
        metrics,
        signals,
        scenarios,
        theses,
        risks,
        catalysts,
        backtests,
        sources,
        modelCalls,
      });
    } catch (loadError) {
      console.error(loadError);
      setError(loadError instanceof Error ? loadError.message : "Unable to load research");
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => filterResearch(data, searchQuery), [data, searchQuery]);
  const primaryThesis = data.theses[0] ?? null;
  const numericMetrics = data.metrics
    .filter((metric) => Number.isFinite(Number(metric.value_numeric)))
    .slice(0, 10);
  const valuationChartData = data.signals
    .filter((signal) => Number.isFinite(Number(signal.cheapness_score)))
    .slice(0, 10)
    .map((signal) => ({
      name: shortLabel(signal.signal_name || signal.signal_key || "Signal", 18),
      score: Number(signal.cheapness_score),
      signal: signal.signal,
    }));
  const runStatus = data.runDetail?.status ?? data.activeRun?.status ?? "unknown";
  const completedStages = (data.runDetail?.stages ?? []).filter(
    (stage: ResearchRecord) => stage.status === "completed" || stage.status === "skipped"
  ).length;
  const totalStages = (data.runDetail?.stages ?? []).length;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f6f8fb] text-sm text-slate-500">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading research report...
      </div>
    );
  }

  if (error || !data.asset) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f6f8fb] px-6">
        <div className="rounded-lg border border-red-200 bg-white p-6 text-sm text-red-700 shadow-sm">
          {error ?? "Asset not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f8fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-5 py-5 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <Link
                href={`/assets/${assetId}`}
                className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-950"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Asset
              </Link>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight text-slate-950">
                  {data.asset.canonical_name}
                </h1>
                <StatusPill value={runStatus} />
                {data.activeRun?.metadata_json?.system_generated && (
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                    System generated
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                <span>{data.asset.asset_kind}</span>
                <span>{data.asset.sector ?? "No sector"}</span>
                <span>{data.asset.base_currency ?? "No currency"}</span>
                <span>Run {shortId(data.activeRun?.id)}</span>
                <span>{formatDate(data.activeRun?.created_at)}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Evidence" value={data.evidence.length} />
              <Kpi label="Metrics" value={data.metrics.length} />
              <Kpi label="Signals" value={data.signals.length} />
              <Kpi label="Stages" value={totalStages ? `${completedStages}/${totalStages}` : "0"} />
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition ${
                      active
                        ? "bg-white text-slate-950 shadow-sm"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="relative min-w-0 lg:w-[360px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search report rows"
                className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-sky-500"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 py-6 lg:px-8">
        {!data.activeRun ? (
          <EmptyState
            title="No research run yet"
            body="Start a run to populate the report."
            actionHref={`/assets/${assetId}/run`}
            actionLabel="Open pipeline"
          />
        ) : (
          <>
            {activeTab === "overview" && (
              <OverviewSection
                thesis={primaryThesis}
                evidence={filtered.evidence.slice(0, 6)}
                metrics={numericMetrics}
                signals={data.signals}
                scenarios={data.scenarios}
                risks={data.risks}
                backtests={data.backtests}
                valuationChartData={valuationChartData}
              />
            )}
            {activeTab === "evidence" && <EvidenceSection evidence={filtered.evidence} />}
            {activeTab === "metrics" && <MetricsSection metrics={filtered.metrics} />}
            {activeTab === "valuation" && (
              <ValuationSection
                signals={filtered.signals}
                scenarios={filtered.scenarios}
                valuationChartData={valuationChartData}
              />
            )}
            {activeTab === "thesis" && (
              <ThesisSection
                theses={filtered.theses}
                risks={filtered.risks}
                catalysts={filtered.catalysts}
              />
            )}
            {activeTab === "backtests" && <BacktestsSection backtests={filtered.backtests} />}
            {activeTab === "sources" && (
              <SourcesSection
                sources={filtered.sources}
                modelCalls={filtered.modelCalls}
                runDetail={data.runDetail}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function OverviewSection({
  thesis,
  evidence,
  metrics,
  signals,
  scenarios,
  risks,
  backtests,
  valuationChartData,
}: {
  thesis: ResearchRecord | null;
  evidence: ResearchRecord[];
  metrics: ResearchRecord[];
  signals: ResearchRecord[];
  scenarios: ResearchRecord[];
  risks: ResearchRecord[];
  backtests: ResearchRecord[];
  valuationChartData: ResearchRecord[];
}) {
  const latestBacktest = backtests[0];
  const backtestMetrics = asRecord(latestBacktest?.metrics_json);
  const signalBreakdown = countBy(signals, "signal");

  return (
    <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={BookOpen} title="Investment View" count={thesis ? 1 : 0} />
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-lg font-semibold leading-snug text-slate-950">
            {thesis?.one_sentence_thesis ?? "No thesis has been generated for this run."}
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <InsightBlock label="Why now" value={thesis?.why_now} />
            <InsightBlock label="Market missing" value={thesis?.market_missing} />
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          <MiniPanel title="Valuation" icon={CircleDollarSign}>
            <div className="space-y-2">
              {Object.entries(signalBreakdown).slice(0, 5).map(([signal, count]) => (
                <div key={signal} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-slate-600">{signal.replace(/_/g, " ")}</span>
                  <span className="font-semibold text-slate-950">{count}</span>
                </div>
              ))}
              {signals.length === 0 && <EmptyLine>No valuation signals.</EmptyLine>}
            </div>
          </MiniPanel>
          <MiniPanel title="Scenarios" icon={Activity}>
            <div className="space-y-2">
              {scenarios.slice(0, 4).map((scenario) => (
                <div key={scenario.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-slate-600">{scenario.scenario_name}</span>
                  <span className="font-semibold text-slate-950">
                    {formatCurrency(scenario.value_anchor, scenario.currency)}
                  </span>
                </div>
              ))}
              {scenarios.length === 0 && <EmptyLine>No scenarios.</EmptyLine>}
            </div>
          </MiniPanel>
          <MiniPanel title="Risk Count" icon={ShieldAlert}>
            <div className="space-y-2">
              {Object.entries(countBy(risks, "severity")).slice(0, 5).map(([severity, count]) => (
                <div key={severity} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-slate-600">{severity || "unknown"}</span>
                  <span className="font-semibold text-slate-950">{count}</span>
                </div>
              ))}
              {risks.length === 0 && <EmptyLine>No risks.</EmptyLine>}
            </div>
          </MiniPanel>
        </div>

        <div className="mt-5">
          <SectionHeader icon={ListChecks} title="Recent Evidence" count={evidence.length} compact />
          <DataTable
            columns={["Claim", "Type", "Confidence", "Status"]}
            rows={evidence.map((claim) => [
              <LongText key="claim" value={claim.claim_text} />,
              cleanLabel(claim.claim_type ?? claim.claim_category),
              formatPercent(claim.confidence),
              <StatusPill key="status" value={claim.review_status} />,
            ])}
          />
        </div>
      </section>

      <aside className="space-y-5">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <SectionHeader icon={BarChart3} title="Metric Snapshot" count={metrics.length} />
          <div className="mt-4 h-[280px]">
            <MetricBarChart metrics={metrics} />
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <SectionHeader icon={CircleDollarSign} title="Cheapness Scores" count={valuationChartData.length} />
          <div className="mt-4 h-[260px]">
            <ValuationScoreChart data={valuationChartData} />
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <SectionHeader icon={Gauge} title="Latest Backtest" count={latestBacktest ? 1 : 0} />
          {latestBacktest ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Kpi label="Return" value={formatPercent(backtestMetrics.total_return)} />
              <Kpi label="Sharpe" value={formatNumber(backtestMetrics.sharpe_ratio)} />
              <Kpi label="Max DD" value={formatPercent(backtestMetrics.max_drawdown)} />
              <Kpi label="Win Rate" value={formatPercent(backtestMetrics.win_rate)} />
            </div>
          ) : (
            <EmptyLine>No backtest results.</EmptyLine>
          )}
        </section>
      </aside>
    </div>
  );
}

function EvidenceSection({ evidence }: { evidence: ResearchRecord[] }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <SectionHeader icon={ListChecks} title="Evidence Claims" count={evidence.length} />
      <DataTable
        columns={["Claim", "Category", "Type", "Confidence", "Review", "Created"]}
        rows={evidence.map((claim) => [
          <LongText key="claim" value={claim.claim_text} />,
          cleanLabel(claim.claim_category),
          cleanLabel(claim.claim_type),
          formatPercent(claim.confidence),
          <StatusPill key="status" value={claim.review_status} />,
          formatDate(claim.created_at),
        ])}
      />
    </section>
  );
}

function MetricsSection({ metrics }: { metrics: ResearchRecord[] }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[0.7fr_1.3fr]">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={BarChart3} title="Numeric Metrics" count={metrics.length} />
        <div className="mt-4 h-[420px]">
          <MetricBarChart metrics={metrics} />
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={Database} title="Metric Observations" count={metrics.length} />
        <DataTable
          columns={["Metric", "Value", "Period", "Provider", "Confidence", "Review"]}
          rows={metrics.map((metric) => [
            <div key="metric" className="min-w-[220px]">
              <div className="font-semibold text-slate-950">
                {metric.metric_display_name ?? metric.metric_key ?? shortId(metric.metric_definition_id)}
              </div>
              <div className="text-xs text-slate-500">{metric.metric_category ?? "uncategorized"}</div>
            </div>,
            formatMetricValue(metric),
            metric.period_end ?? metric.as_of_date ?? "n/a",
            metric.data_provider ?? "n/a",
            formatPercent(metric.confidence),
            <StatusPill key="status" value={metric.review_status} />,
          ])}
        />
      </section>
    </div>
  );
}

function ValuationSection({
  signals,
  scenarios,
  valuationChartData,
}: {
  signals: ResearchRecord[];
  scenarios: ResearchRecord[];
  valuationChartData: ResearchRecord[];
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <SectionHeader icon={CircleDollarSign} title="Cheapness Scores" count={valuationChartData.length} />
          <div className="mt-4 h-[360px]">
            <ValuationScoreChart data={valuationChartData} />
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <SectionHeader icon={CircleDollarSign} title="Valuation Signals" count={signals.length} />
          <DataTable
            columns={["Signal", "Lens", "Current", "Cheapness", "Call", "Confidence"]}
            rows={signals.map((signal) => [
              <div key="signal" className="min-w-[220px]">
                <div className="font-semibold text-slate-950">{signal.signal_name}</div>
                <div className="text-xs text-slate-500">{signal.signal_key}</div>
              </div>,
              cleanLabel(signal.lens_family),
              signal.current_value_text ?? formatNumber(signal.current_value),
              formatNumber(signal.cheapness_score),
              <SignalPill key="signal-pill" value={signal.signal} />,
              formatPercent(signal.confidence),
            ])}
          />
        </section>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={Activity} title="Scenarios" count={scenarios.length} />
        <DataTable
          columns={["Scenario", "Type", "Probability", "Value Anchor", "Assumptions", "Review"]}
          rows={scenarios.map((scenario) => [
            <div key="scenario" className="min-w-[180px] font-semibold text-slate-950">
              {scenario.scenario_name}
            </div>,
            cleanLabel(scenario.scenario_type),
            formatPercent(scenario.probability),
            formatCurrency(scenario.value_anchor, scenario.currency),
            <JsonPreview key="json" value={scenario.assumptions_json} />,
            <StatusPill key="status" value={scenario.review_status} />,
          ])}
        />
      </section>
    </div>
  );
}

function ThesisSection({
  theses,
  risks,
  catalysts,
}: {
  theses: ResearchRecord[];
  risks: ResearchRecord[];
  catalysts: ResearchRecord[];
}) {
  return (
    <div className="space-y-5">
      {theses.length === 0 ? (
        <EmptyState title="No thesis records" body="This run has not stored a thesis yet." />
      ) : (
        theses.map((thesis) => (
          <section key={thesis.id} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <SectionHeader icon={Brain} title="Thesis" count={thesis.drivers?.length ?? 0} />
            <p className="mt-4 text-lg font-semibold leading-snug text-slate-950">
              {thesis.one_sentence_thesis}
            </p>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <InsightBlock label="Why now" value={thesis.why_now} />
              <InsightBlock label="Market missing" value={thesis.market_missing} />
            </div>
            <div className="mt-5">
              <SectionHeader icon={Activity} title="Drivers" count={thesis.drivers?.length ?? 0} compact />
              <DataTable
                columns={["Driver", "Type", "Impact", "Confidence", "Description"]}
                rows={(thesis.drivers ?? []).map((driver: ResearchRecord) => [
                  driver.driver_name,
                  cleanLabel(driver.driver_type),
                  driver.value_impact ?? "n/a",
                  formatPercent(driver.confidence),
                  <LongText key="description" value={driver.description} />,
                ])}
              />
            </div>
          </section>
        ))
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={AlertTriangle} title="Risks" count={risks.length} />
        <DataTable
          columns={["Risk", "Type", "Severity", "Probability", "Description", "Mitigants"]}
          rows={risks.map((risk) => [
            <div key="risk" className="min-w-[180px] font-semibold text-slate-950">
              {risk.risk_name}
            </div>,
            cleanLabel(risk.risk_type),
            <SeverityPill key="severity" value={risk.severity} />,
            cleanLabel(risk.probability),
            <LongText key="description" value={risk.description} />,
            <JsonPreview key="mitigants" value={risk.mitigants_json} />,
          ])}
        />
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={CheckCircle2} title="Catalysts" count={catalysts.length} />
        <DataTable
          columns={["Catalyst", "Type", "Expected Date", "Impact", "Status", "Description"]}
          rows={catalysts.map((catalyst) => [
            <div key="catalyst" className="min-w-[180px] font-semibold text-slate-950">
              {catalyst.catalyst_name}
            </div>,
            cleanLabel(catalyst.catalyst_type),
            catalyst.expected_date ?? "n/a",
            cleanLabel(catalyst.upside_downside),
            <StatusPill key="status" value={catalyst.status} />,
            <LongText key="description" value={catalyst.description} />,
          ])}
        />
      </section>
    </div>
  );
}

function BacktestsSection({ backtests }: { backtests: ResearchRecord[] }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <SectionHeader icon={Gauge} title="Backtest Runs" count={backtests.length} />
      <DataTable
        columns={["Name", "Status", "Return", "Sharpe", "Max Drawdown", "Period", "Metrics"]}
        rows={backtests.map((backtest) => {
          const metrics = asRecord(backtest.metrics_json);
          return [
            <div key="name" className="min-w-[220px]">
              <div className="font-semibold text-slate-950">{backtest.name ?? backtest.strategy_name ?? "Backtest"}</div>
              <div className="text-xs text-slate-500">{shortId(backtest.id)}</div>
            </div>,
            <StatusPill key="status" value={backtest.status} />,
            formatPercent(metrics.total_return),
            formatNumber(metrics.sharpe_ratio),
            formatPercent(metrics.max_drawdown),
            `${backtest.start_date ?? "n/a"} to ${backtest.end_date ?? "n/a"}`,
            <JsonPreview key="json" value={metrics} />,
          ];
        })}
      />
    </section>
  );
}

function SourcesSection({
  sources,
  modelCalls,
  runDetail,
}: {
  sources: ResearchRecord[];
  modelCalls: ResearchRecord[];
  runDetail: ResearchRecord | null;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={FileText} title="Source Documents" count={sources.length} />
        <DataTable
          columns={["Source", "Publisher", "Date", "Ingest", "Trust", "URI"]}
          rows={sources.map((source) => [
            <div key="source" className="min-w-[240px]">
              <div className="font-semibold text-slate-950">{source.title ?? source.document_title ?? "Source"}</div>
              <div className="text-xs text-slate-500">{source.source_type ?? source.document_type}</div>
            </div>,
            source.publisher ?? source.source_name ?? "n/a",
            source.document_date ?? source.published_at ?? "n/a",
            <StatusPill key="status" value={source.ingest_status ?? source.status} />,
            formatPercent(source.trust_score),
            source.uri ? (
              <a
                key="uri"
                href={String(source.uri)}
                target="_blank"
                rel="noreferrer"
                className="max-w-[260px] truncate text-sky-700 hover:text-sky-900"
              >
                {String(source.uri)}
              </a>
            ) : (
              "n/a"
            ),
          ])}
        />
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={Activity} title="Pipeline Stages" count={runDetail?.stages?.length ?? 0} />
        <DataTable
          columns={["Stage", "Status", "Started", "Completed", "Notes"]}
          rows={(runDetail?.stages ?? []).map((stage: ResearchRecord) => [
            <div key="stage" className="min-w-[220px] font-semibold text-slate-950">
              {stage.stage_name ?? stage.stage_key}
            </div>,
            <StatusPill key="status" value={stage.status} />,
            formatDateTime(stage.started_at),
            formatDateTime(stage.completed_at),
            <LongText key="notes" value={stage.error_message ?? stage.skip_reason ?? stage.notes} />,
          ])}
        />
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionHeader icon={Brain} title="Agent Model Calls" count={modelCalls.length} />
        <DataTable
          columns={["Agent", "Model", "Tier", "Status", "Tokens", "Latency", "Cost"]}
          rows={modelCalls.map((call) => [
            call.agent_name ?? "n/a",
            `${call.model_provider ?? ""} ${call.model_name ?? ""}`.trim(),
            call.model_tier ?? "n/a",
            <StatusPill key="status" value={call.status} />,
            `${call.input_tokens ?? 0} in / ${call.output_tokens ?? 0} out`,
            call.latency_ms ? `${formatNumber(call.latency_ms)} ms` : "n/a",
            formatCurrency(call.cost_usd, "USD"),
          ])}
        />
      </section>
    </div>
  );
}

function MetricBarChart({ metrics }: { metrics: ResearchRecord[] }) {
  const chartData = metrics
    .filter((metric) => Number.isFinite(Number(metric.value_numeric)))
    .slice(0, 12)
    .map((metric) => ({
      name: shortLabel(
        metric.metric_display_name ?? metric.metric_key ?? shortId(metric.metric_definition_id),
        16
      ),
      value: Number(metric.value_numeric),
    }));

  if (chartData.length === 0) {
    return <EmptyChart label="No numeric metric values" />;
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ReBarChart data={chartData} layout="vertical" margin={{ left: 18, right: 12, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
        <XAxis type="number" tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis dataKey="name" type="category" width={120} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <Tooltip
          cursor={{ fill: "#f1f5f9" }}
          formatter={(value) => formatNumber(value)}
          contentStyle={{ borderRadius: 8, borderColor: "#e2e8f0", fontSize: 12 }}
        />
        <Bar dataKey="value" fill="#0f766e" radius={[0, 4, 4, 0]} />
      </ReBarChart>
    </ResponsiveContainer>
  );
}

function ValuationScoreChart({ data }: { data: ResearchRecord[] }) {
  if (data.length === 0) {
    return <EmptyChart label="No valuation scores" />;
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ReBarChart data={data} margin={{ left: 12, right: 12, top: 8, bottom: 42 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
        <XAxis dataKey="name" angle={-28} textAnchor="end" interval={0} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <Tooltip
          cursor={{ fill: "#f1f5f9" }}
          formatter={(value) => formatNumber(value)}
          contentStyle={{ borderRadius: 8, borderColor: "#e2e8f0", fontSize: 12 }}
        />
        <Bar dataKey="score" radius={[4, 4, 0, 0]}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={signalColors[String(entry.signal)] ?? "#2563eb"} />
          ))}
        </Bar>
      </ReBarChart>
    </ResponsiveContainer>
  );
}

function DataTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Array<Array<React.ReactNode>>;
}) {
  if (rows.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
        No rows for this section.
      </div>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50">
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                className="whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase text-slate-500"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3 text-slate-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  count,
  compact = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count: number;
  compact?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${compact ? "" : "min-h-8"}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-100 text-slate-700">
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-bold text-slate-950">{title}</h2>
      </div>
      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
        {count}
      </span>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-bold text-slate-950">{value}</div>
    </div>
  );
}

function MiniPanel({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase text-slate-500">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      {children}
    </div>
  );
}

function InsightBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 text-xs font-bold uppercase text-slate-500">{label}</div>
      <p className="text-sm leading-relaxed text-slate-700">{safeText(value)}</p>
    </div>
  );
}

function EmptyState({
  title,
  body,
  actionHref,
  actionLabel,
}: {
  title: string;
  body: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-10 text-center shadow-sm">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">
        <FileText className="h-5 w-5 text-slate-500" />
      </div>
      <h2 className="text-base font-bold text-slate-950">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
      {actionHref && actionLabel && (
        <Link
          href={actionHref}
          className="mt-4 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
      {label}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-slate-500">{children}</div>;
}

function LongText({ value }: { value: unknown }) {
  return <div className="max-w-[620px] whitespace-normal leading-relaxed">{safeText(value)}</div>;
}

function JsonPreview({ value }: { value: unknown }) {
  const text = stringifyCompact(value);
  return <div className="max-w-[420px] whitespace-normal text-xs leading-relaxed text-slate-600">{text}</div>;
}

function StatusPill({ value }: { value: unknown }) {
  const label = cleanLabel(value);
  const tone =
    label.includes("complete") || label.includes("accepted") || label.includes("open")
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : label.includes("fail") || label.includes("error")
        ? "border-red-200 bg-red-50 text-red-700"
        : label.includes("pending") || label.includes("running")
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-slate-200 bg-slate-50 text-slate-600";

  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}

function SignalPill({ value }: { value: unknown }) {
  const label = cleanLabel(value);
  const color = signalColors[String(value)] ?? "#64748b";

  return (
    <span
      className="inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {label}
    </span>
  );
}

function SeverityPill({ value }: { value: unknown }) {
  const label = cleanLabel(value);
  const tone =
    label.includes("high") || label.includes("severe")
      ? "bg-red-50 text-red-700 border-red-200"
      : label.includes("medium") || label.includes("moderate")
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-slate-50 text-slate-600 border-slate-200";

  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    return fallback;
  }
  return response.json();
}

function filterResearch(data: ResearchData, query: string): ResearchData {
  if (!query.trim()) return data;
  const needle = query.toLowerCase();
  const filterRows = (rows: ResearchRecord[]) =>
    rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));

  return {
    ...data,
    evidence: filterRows(data.evidence),
    metrics: filterRows(data.metrics),
    signals: filterRows(data.signals),
    scenarios: filterRows(data.scenarios),
    theses: filterRows(data.theses),
    risks: filterRows(data.risks),
    catalysts: filterRows(data.catalysts),
    backtests: filterRows(data.backtests),
    sources: filterRows(data.sources),
    modelCalls: filterRows(data.modelCalls),
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function countBy(rows: ResearchRecord[], key: string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = String(row[key] ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function safeText(value: unknown, fallback = "n/a") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") return value;
  return stringifyCompact(value);
}

function stringifyCompact(value: unknown) {
  if (value === null || value === undefined || value === "") return "n/a";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "n/a";
  }
}

function cleanLabel(value: unknown) {
  return safeText(value, "n/a").replace(/_/g, " ").toLowerCase();
}

function shortId(value: unknown) {
  const text = safeText(value, "n/a");
  return text === "n/a" ? text : text.slice(0, 8);
}

function shortLabel(value: unknown, length: number) {
  const text = safeText(value);
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function formatMetricValue(metric: ResearchRecord) {
  if (metric.value_numeric !== null && metric.value_numeric !== undefined) {
    const value = formatNumber(metric.value_numeric);
    const unit = metric.unit ?? metric.currency ?? "";
    return `${value}${unit ? ` ${unit}` : ""}`;
  }
  return safeText(metric.value_text);
}

function formatNumber(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return safeText(value);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: numberValue >= 100 ? 0 : 3,
  }).format(numberValue);
}

function formatCurrency(value: unknown, currency: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return safeText(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: typeof currency === "string" && currency.length === 3 ? currency : "USD",
    maximumFractionDigits: numberValue >= 100 ? 0 : 2,
  }).format(numberValue);
}

function formatPercent(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return safeText(value);
  const percentValue = Math.abs(numberValue) <= 1 ? numberValue * 100 : numberValue;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(percentValue)}%`;
}

function formatDate(value: unknown) {
  if (!value) return "n/a";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
}

function formatDateTime(value: unknown) {
  if (!value) return "n/a";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}
