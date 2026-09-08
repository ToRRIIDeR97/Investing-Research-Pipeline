"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, CircleDollarSign, Database, FileText, Gauge, ListChecks, RefreshCw, ShieldAlert, TrendingUp } from "lucide-react";
import { MarkdownReport } from "@/components/report/markdown-report";
import { ChartBuilder, type ChartAssetOption } from "@/components/charts";
import { CHART_MAX_SERIES, createDefaultChartViewConfig, type ChartSeriesConfig, type ChartViewConfig } from "@/lib/charts/config";
import { encodeChartViewConfig, readChartViewConfigFromUrl } from "@/lib/charts/url-state";
import {
  CANONICAL_REPORT_SECTIONS,
  RESEARCH_TABS,
  buildFinancialMetricMatrix,
  canonicalHeadingAnchor,
  tabForCanonicalHeading,
  tabPath,
  type ResearchTabSlug,
  safeMarkdownHref,
} from "@/lib/research/report-ui";

type AnyRecord = Record<string, any>;

interface ResearchState {
  asset: AnyRecord | null;
  runs: AnyRecord[];
  activeRun: AnyRecord | null;
  runDetail: AnyRecord | null;
  report: AnyRecord | null;
}

const EMPTY: ResearchState = { asset: null, runs: [], activeRun: null, runDetail: null, report: null };

export default function ResearchSectionPage() {
  const params = useParams<{ id: string; section: string }>();
  const assetId = String(params.id);
  const requestedSection = String(params.section) as ResearchTabSlug;
  const section = RESEARCH_TABS.some((tab) => tab.slug === requestedSection) ? requestedSection : "general";
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requestedRunId = searchParams.get("run");
  const [state, setState] = useState<ResearchState>(EMPTY);
  const [assetOptions, setAssetOptions] = useState<ChartAssetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [asset, runs] = await Promise.all([
        fetchRequired<AnyRecord>(`/api/assets/${encodeURIComponent(assetId)}`, signal),
        fetchRequired<AnyRecord[]>(`/api/assets/${encodeURIComponent(assetId)}/research-runs`, signal),
      ]);
      const allAssets = await fetchRequired<AnyRecord[]>("/api/assets", signal).catch(() => []);
      setAssetOptions(allAssets.map((item) => ({ id: String(item.id), name: String(item.canonical_name ?? item.slug ?? item.id), symbol: item.symbol ? String(item.symbol) : null })));
      const sortedRuns = [...(Array.isArray(runs) ? runs : [])].sort(
        (left, right) => new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime()
      );
      const activeRun = sortedRuns.find((run) => String(run.id) === requestedRunId) ?? sortedRuns[0] ?? null;
      if (!activeRun) {
        setState({ asset, runs: sortedRuns, activeRun: null, runDetail: null, report: null });
        return;
      }
      const [runDetail, report] = await Promise.all([
        fetchRequired<AnyRecord>(`/api/research-runs/${encodeURIComponent(String(activeRun.id))}`, signal),
        fetchRequired<AnyRecord>(`/api/research-runs/${encodeURIComponent(String(activeRun.id))}/report`, signal),
      ]);
      setState({ asset, runs: sortedRuns, activeRun, runDetail, report });
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load this research section.");
    } finally {
      setLoading(false);
    }
  }, [assetId, requestedRunId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const runId = state.activeRun?.id ? String(state.activeRun.id) : null;
  const report = state.report;
  const readModels = (report?.read_models ?? {}) as AnyRecord;
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts as AnyRecord[] : [];
  const missingSections = Array.isArray(report?.missing_sections) ? report.missing_sections as AnyRecord[] : [];

  function selectRun(nextRunId: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (nextRunId) next.set("run", nextRunId);
    else next.delete("run");
    // Keep a compatible saved chart while moving its selected-run series to the new run.
    if (typeof window !== "undefined") {
      const chart = readChartViewConfigFromUrl(window.location.href);
      if (chart?.anchorAssetId === assetId) {
        next.set("chart", encodeChartViewConfig({
          ...chart,
          runId: nextRunId || undefined,
          series: chart.series.map((series) => series.assetId === assetId && series.kind !== "price"
            ? { ...series, runId: nextRunId || undefined }
            : series),
        }));
      }
    }
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

  if (loading) return <PageState icon={<RefreshCw className="h-4 w-4 animate-spin" />} title="Loading research" body="Preparing the selected run and report blocks…" />;
  if (error) return <PageState icon={<AlertTriangle className="h-4 w-4" />} title="Research could not be loaded" body={error} actionLabel="Retry" onAction={() => void load()} />;
  if (!state.asset) return <PageState title="Asset not found" body="This research workspace no longer exists." />;

  return (
    <div className="min-h-screen bg-[#f6f8fb] text-slate-950">
      <AssetResearchHeader asset={state.asset} activeRun={state.activeRun} runs={state.runs} section={section} onRunChange={selectRun} runId={runId} />
      <main className="mx-auto max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8">
        {!state.activeRun ? (
          <EmptyState title="No research run yet" body="Start a pipeline run to populate this workspace." actionHref={`/assets/${encodeURIComponent(assetId)}/run`} actionLabel="Open pipeline" />
        ) : (
          <SectionContent section={section} assetId={assetId} runId={runId} report={report ?? {}} readModels={readModels} artifacts={artifacts} runDetail={state.runDetail} runs={state.runs} missingSections={missingSections} assetOptions={assetOptions} />
        )}
      </main>
    </div>
  );
}

function AssetResearchHeader({
  asset,
  activeRun,
  runs,
  section,
  runId,
  onRunChange,
}: {
  asset: AnyRecord;
  activeRun: AnyRecord | null;
  runs: AnyRecord[];
  section: ResearchTabSlug;
  runId: string | null;
  onRunChange: (runId: string) => void;
}) {
  const assetId = String(asset.id);
  const listing = Array.isArray(asset.listings) ? asset.listings.find((item: AnyRecord) => item.is_primary) ?? asset.listings[0] : null;
  const runStatus = String(activeRun?.status ?? "not started");
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-[1480px] px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <Link href="/assets" className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-950"><ArrowLeft className="h-3.5 w-3.5" />All assets</Link>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{String(asset.canonical_name ?? "Asset")}</h1>
              {listing?.symbol && <span className="font-mono text-xs font-semibold text-slate-500">{String(listing.symbol)}</span>}
              <StatusPill value={runStatus} />
            </div>
            <p className="mt-1 text-xs text-slate-500">{String(asset.asset_kind ?? "asset")} · {String(asset.sector ?? "No sector")} · {String(asset.base_currency ?? "No currency")} {activeRun ? `· updated ${formatDate(activeRun.created_at)}` : ""}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-2 font-semibold text-slate-500">Run
              <select aria-label="Select research run" value={runId ?? ""} onChange={(event) => onRunChange(event.target.value)} className="max-w-[280px] rounded-md border border-slate-200 bg-white px-2.5 py-2 font-mono text-xs text-slate-700 outline-none focus:border-sky-500">
                {runs.map((run) => <option key={String(run.id)} value={String(run.id)}>{shortId(run.id)} · {cleanLabel(run.status)} · {formatDate(run.created_at)}</option>)}
              </select>
            </label>
            <Link href={`/assets/${encodeURIComponent(assetId)}/run${runId ? `?run=${encodeURIComponent(runId)}` : ""}`} className="rounded-md border border-slate-200 px-3 py-2 font-semibold text-slate-600 hover:border-slate-400 hover:text-slate-950">Operations</Link>
          </div>
        </div>
        <nav aria-label="Research sections" role="tablist" className="mt-4 flex gap-1 overflow-x-auto border-t border-slate-100 pt-3">
          {RESEARCH_TABS.map((tab) => {
            const active = tab.slug === section;
            return <Link key={tab.slug} href={tabPath(assetId, tab.slug, runId)} role="tab" aria-selected={active} aria-current={active ? "page" : undefined} className={`shrink-0 rounded-md px-3 py-2 text-xs font-semibold transition ${active ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-950"}`}>{tab.label}</Link>;
          })}
        </nav>
      </div>
    </header>
  );
}

function SectionContent({ section, assetId, runId, report, readModels, artifacts, runDetail, runs, missingSections, assetOptions }: { section: ResearchTabSlug; assetId: string; runId: string | null; report: AnyRecord; readModels: AnyRecord; artifacts: AnyRecord[]; runDetail: AnyRecord | null; runs: AnyRecord[]; missingSections: AnyRecord[]; assetOptions: ChartAssetOption[] }) {
  const provenance = asRecord(report.provenance);
  if (section === "general") return <GeneralSection assetId={assetId} runId={runId} report={report} readModels={readModels} artifacts={artifacts} missingSections={missingSections} assetOptions={assetOptions} />;
  if (section === "financials") return <FinancialsSection assetId={assetId} runId={runId} readModels={readModels} artifacts={artifacts} assetOptions={assetOptions} />;
  if (section === "valuation") return <ValuationSection assetId={assetId} runId={runId} readModels={readModels} artifacts={artifacts} assetOptions={assetOptions} provenance={{ valuation: rows(provenance.valuation), scenarios: rows(provenance.scenarios) }} />;
  if (section === "thesis") return <ThesisSection assetId={assetId} runId={runId} readModels={readModels} />;
  if (section === "evidence") return <EvidenceSection assetId={assetId} runId={runId} readModels={readModels} provenance={rows((report as AnyRecord).provenance?.evidence)} />;
  if (section === "backtests") return <BacktestsSection assetId={assetId} runId={runId} readModels={readModels} />;
  return <UpdatesSection assetId={assetId} runId={runId} report={report} artifacts={artifacts} runDetail={runDetail} runs={runs} missingSections={missingSections} />;
}

function GeneralSection({ assetId, runId, report, readModels, artifacts, missingSections, assetOptions }: { assetId: string; runId: string | null; report: AnyRecord; readModels: AnyRecord; artifacts: AnyRecord[]; missingSections: AnyRecord[]; assetOptions: ChartAssetOption[] }) {
  const evidence = rows(readModels.evidence);
  const metrics = rows(readModels.metrics);
  const signals = rows(readModels.valuation_signals);
  const scenarios = rows(readModels.scenarios);
  const theses = rows(readModels.theses);
  const risks = rows(readModels.risks);
  const monitoring = artifactContent(artifacts, "monitoring_dashboard");
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_270px]">
      <div className="min-w-0 space-y-5">
        <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <LiveBlock href={tabPath(assetId, "thesis", runId)} icon={<BookOpen className="h-4 w-4" />} label="Decision" value={theses[0]?.one_sentence_thesis ?? theses[0]?.thesis ?? "No thesis recorded"} />
          <LiveBlock href={tabPath(assetId, "evidence", runId)} icon={<ListChecks className="h-4 w-4" />} label="Evidence" value={`${evidence.length} claims`} />
          <LiveBlock href={tabPath(assetId, "financials", runId)} icon={<TrendingUp className="h-4 w-4" />} label="KPIs" value={`${metrics.length} observations`} />
          <LiveBlock href={tabPath(assetId, "valuation", runId)} icon={<CircleDollarSign className="h-4 w-4" />} label="Valuation" value={`${signals.length} signals · ${scenarios.length} scenarios`} />
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950"><span className="font-semibold">Reader view.</span> Structured values below are live from the selected run. Open a section for its full tables and provenance.</div>
        <ChartBuilder key={`chart:${assetId}:${runId ?? "latest"}:general`} assetId={assetId} assetOptions={assetOptions} initialConfig={chartConfig(assetId, runId, "price", "close", "Price history")} />
        <MonitoringTrendTable dashboard={monitoring} />
        {report.canonical_markdown_source === "live_preview" && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"><span className="font-semibold">Draft Markdown preview.</span> This report is assembled from accepted artifacts; the final export remains gated by human review.</div>}
        {report.canonical_markdown ? <MarkdownReport markdown={String(report.canonical_markdown)} assetId={assetId} runId={runId} /> : <ArtifactReportFallback artifacts={artifacts} missingSections={missingSections} />}
      </div>
      <ReportContents assetId={assetId} runId={runId} />
    </div>
  );
}

function ReportContents({ assetId, runId }: { assetId: string; runId: string | null }) {
  return <aside className="hidden lg:block"><div className="sticky top-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500"><FileText className="h-4 w-4" />Report contents</div><ol className="space-y-1.5">{CANONICAL_REPORT_SECTIONS.map(([number, title]) => { const tab = tabForCanonicalHeading(number); return <li key={number}><Link href={`${tabPath(assetId, tab, runId)}#${canonicalHeadingAnchor(number)}`} className="block rounded px-2 py-1 text-xs leading-5 text-slate-600 hover:bg-slate-50 hover:text-slate-950"><span className="mr-1 font-mono text-slate-400">{number}.</span>{title}</Link></li>; })}</ol></div></aside>;
}

function ArtifactReportFallback({ artifacts, missingSections }: { artifacts: AnyRecord[]; missingSections: AnyRecord[] }) {
  return <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><div className="mb-4 flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /><h2 className="text-base font-bold">Canonical export is not ready</h2></div><p className="text-sm leading-6 text-slate-600">The selected run has persisted artifacts, but its final Markdown export is still gated. Review the live sections while the pipeline completes.</p><div className="mt-5 grid gap-3 sm:grid-cols-2">{artifacts.slice(0, 8).map((artifact) => <div key={String(artifact.id)} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"><div className="font-semibold text-slate-800">{cleanLabel(artifact.type ?? artifact.artifact_type)}</div><div className="mt-1 text-slate-500">{cleanLabel(artifact.status)}</div></div>)}</div>{missingSections.length > 0 && <div className="mt-5 rounded-lg border border-dashed border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><div className="font-semibold">Incomplete sections</div><ul className="mt-1 list-disc pl-4">{missingSections.map((item) => <li key={String(item.type)}>{String(item.label ?? item.type)}</li>)}</ul></div>}</section>;
}

function FinancialsSection({ assetId, runId, readModels, artifacts, assetOptions }: { assetId: string; runId: string | null; readModels: AnyRecord; artifacts: AnyRecord[]; assetOptions: ChartAssetOption[] }) {
  const metrics = rows(readModels.metrics);
  const coverage = rows(artifactContent(artifacts, "historical_record").metric_coverage);
  return <SectionShell title="Financials & KPIs" description="Select metric rows to compare their reported values in the chart." icon={<TrendingUp className="h-5 w-5" />}><CanonicalAnchor number={5} /><FinancialMetricsWorkspace key={runId ?? "latest"} assetId={assetId} runId={runId} metrics={metrics} assetOptions={assetOptions} />{coverage.length > 0 && <section className="space-y-3"><div><h3 className="text-sm font-bold">Priority KPI coverage</h3><p className="mt-0.5 text-xs text-slate-500">Shows whether each required KPI was extracted, mentioned but missed, or absent from the acquired snapshot.</p></div><DataTable columns={["Metric", "Status", "Observations", "Source mentions", "Reason"]} rows={coverage.map((item) => [displayMetricLabel(item.metric_key), <StatusPill key="status" value={item.status} />, formatNumber(item.observation_count), formatNumber(item.source_mentions), String(item.reason ?? "Covered")])} /></section>}<CanonicalAnchor number={6} /><CanonicalAnchor number={12} /><CanonicalAnchor number={13} /><CanonicalAnchor number={14} /><CanonicalAnchor number={15} /><SectionLink href={tabPath(assetId, "general", runId)} label="Return to the full report" /></SectionShell>;
}

function FinancialMetricsWorkspace({ assetId, runId, metrics, assetOptions }: { assetId: string; runId: string | null; metrics: AnyRecord[]; assetOptions: ChartAssetOption[] }) {
  const matrix = useMemo(() => buildFinancialMetricMatrix(metrics), [metrics]);
  const [selectedKeys, setSelectedKeys] = useState(() => matrix.metrics.slice(0, 2).map((metric) => metric.key));
  const selectedMetrics = matrix.metrics.filter((metric) => selectedKeys.includes(metric.key));
  const chartConfig = useMemo<ChartViewConfig | null>(() => {
    if (selectedMetrics.length === 0) return null;
    const base = createDefaultChartViewConfig(assetId);
    const dimensions = new Set(selectedMetrics.map((metric) => `${metric.unit ?? ""}:${metric.currency ?? ""}`));
    return {
      ...base,
      name: "Selected financial metrics",
      runId: runId ?? undefined,
      range: { preset: "MAX" },
      normalization: dimensions.size > 1 ? "indexed" : "absolute",
      series: selectedMetrics.map((metric) => ({
        kind: "metric" as const,
        assetId,
        key: metric.key,
        runId: runId ?? undefined,
        label: displayMetricLabel(metric.label),
      })),
    };
  }, [assetId, runId, selectedMetrics]);

  function toggleMetric(key: string) {
    setSelectedKeys((current) => current.includes(key)
      ? current.filter((selected) => selected !== key)
      : current.length < CHART_MAX_SERIES ? [...current, key] : current);
  }

  if (matrix.metrics.length === 0) return <EmptyLine>No metric observations were persisted for this run.</EmptyLine>;
  return <div className="space-y-4">
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-sm font-bold text-slate-900">Financial metric chart</h3><p className="mt-0.5 text-xs text-slate-500">{selectedKeys.length} selected · hover for period and value</p></div>
        {selectedKeys.length > 0 && <button type="button" onClick={() => setSelectedKeys([])} className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-400">Clear</button>}
      </div>
      {chartConfig ? <ChartBuilder compact key={selectedKeys.join(":")} assetId={assetId} assetOptions={assetOptions} initialConfig={chartConfig} /> : <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">Select one or more metrics in the table below.</div>}
    </section>
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-max border-collapse text-right text-sm">
        <caption className="sr-only">Financial metrics by reporting period; select rows to add them to the chart.</caption>
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500"><tr><th scope="col" className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-50 px-4 py-3 text-left" style={{ minWidth: "220px" }}>Metric</th>{matrix.periods.map((period) => <th key={period} scope="col" className="min-w-32 border-b border-slate-200 px-4 py-3">{period}</th>)}</tr></thead>
        <tbody>{matrix.metrics.map((metric) => {
          const checked = selectedKeys.includes(metric.key);
          const disabled = !checked && selectedKeys.length >= CHART_MAX_SERIES;
          const unit = [metric.unit, metric.currency && metric.currency !== metric.unit ? metric.currency : null].filter(Boolean).join(" · ");
          return <tr key={metric.key} className={checked ? "bg-sky-50/50" : "hover:bg-slate-50/70"}><th scope="row" className={`sticky left-0 z-10 border-r border-t border-slate-100 px-4 py-3 text-left ${checked ? "bg-sky-50" : "bg-white"}`} style={{ minWidth: "220px" }}><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleMetric(metric.key)} className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-slate-950" /><span><span className="block font-semibold text-slate-800">{displayMetricLabel(metric.label)}</span>{unit && <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-wide text-slate-400">{unit}</span>}</span></label></th>{matrix.periods.map((period) => <td key={period} className="border-t border-slate-100 px-4 py-3 font-mono tabular-nums text-slate-700">{formatRawMetricValue(metric.values[period])}</td>)}</tr>;
        })}</tbody>
      </table>
    </div>
    <p className="text-xs text-slate-400">Raw stored values are shown by reporting period. Select up to {CHART_MAX_SERIES} metric rows.</p>
  </div>;
}

function ValuationSection({ assetId, runId, readModels, artifacts, assetOptions, provenance }: { assetId: string; runId: string | null; readModels: AnyRecord; artifacts: AnyRecord[]; assetOptions: ChartAssetOption[]; provenance: { valuation: AnyRecord[]; scenarios: AnyRecord[] } }) {
  const signals = rows(readModels.valuation_signals);
  const scenarios = rows(readModels.scenarios);
  const targets = priceTargets(artifacts);
  const valuationConfig = createValuationChartConfig(assetId, runId, signals, scenarios);
  const methodRun = artifactContent(artifacts, "valuation_method_run");
  const expectedReturn = artifactContent(artifacts, "expected_return_matrix");
  const provenanceBySignal = new Map(provenance.valuation.map((item) => [String(item.valuation_signal_id ?? item.entity_id ?? item.signal_key ?? ""), item]));
  const provenanceByScenario = new Map(provenance.scenarios.map((item) => [String(item.scenario_id ?? item.entity_id ?? item.scenario_name ?? ""), item]));
  return <SectionShell title="Valuation" description="Reproducible valuation methods, scenario outputs, and expected returns." icon={<CircleDollarSign className="h-5 w-5" />}><CanonicalAnchor number={16} /><ChartBuilder key={`chart:${assetId}:${runId ?? "latest"}:valuation`} assetId={assetId} assetOptions={assetOptions} initialConfig={valuationConfig} /><ValuationMethodBreakdown methodRun={methodRun} /><CanonicalAnchor number={17} /><div className="grid gap-5 xl:grid-cols-2"><DataTable columns={["Signal", "Lens", "Current", "Cheapness", "Call", "Provenance"]} rows={signals.map((signal) => { const source = provenanceBySignal.get(String(signal.id ?? signal.signal_key ?? "")); return [<div key="name" className="font-semibold">{String(signal.signal_name ?? signal.signal_key ?? "Signal")}</div>, cleanLabel(signal.lens_family), String(signal.current_value_text ?? signal.current_value ?? "n/a"), formatNumber(signal.cheapness_score), <StatusPill key="signal" value={signal.signal} />, <ProvenanceCell key="provenance" value={source} />]; })} empty="No valuation signals were persisted." /><DataTable columns={["Scenario", "Type", "Probability", "Value anchor", "Provenance"]} rows={scenarios.map((scenario) => { const source = provenanceByScenario.get(String(scenario.id ?? scenario.scenario_name ?? "")); return [String(scenario.scenario_name ?? "Scenario"), cleanLabel(scenario.scenario_type), formatPercent(scenario.probability), formatCurrency(scenario.value_anchor, scenario.currency), <ProvenanceCell key="provenance" value={source} />]; })} empty="No valuation scenarios were persisted." /></div><CanonicalAnchor number={18} />{targets.length > 0 && <div className="mt-5"><DataTable columns={["Fiscal year", "Bear", "Base", "Bull"]} rows={groupPriceTargets(targets).map((row) => [row.year, formatCurrency(row.bear, "USD"), formatCurrency(row.base, "USD"), formatCurrency(row.bull, "USD")])} /></div>}<CanonicalAnchor number={19} /><ExpectedReturnTable matrix={expectedReturn} /><SectionLink href={tabPath(assetId, "general", runId)} label="Return to the full report" /></SectionShell>;
}

function ThesisSection({ assetId, runId, readModels }: { assetId: string; runId: string | null; readModels: AnyRecord }) {
  const theses = rows(readModels.theses);
  const risks = rows(readModels.risks);
  const catalysts = rows(readModels.catalysts);
  return <SectionShell title="Thesis & Risks" description="The selected run's investment view and invalidation signals." icon={<ShieldAlert className="h-5 w-5" />}><CanonicalAnchor number={20} /><div className="space-y-5">{theses.length === 0 ? <EmptyLine>No thesis has been persisted.</EmptyLine> : theses.map((thesis, index) => <section key={String(thesis.id ?? index)} className="rounded-lg border border-slate-200 bg-slate-50 p-4"><h2 className="text-lg font-bold">{String(thesis.one_sentence_thesis ?? thesis.thesis ?? "Investment thesis")}</h2><div className="mt-3 grid gap-3 sm:grid-cols-2"><Info label="Why now" value={thesis.why_now} /><Info label="Market missing" value={thesis.market_missing} /></div></section>)}<CanonicalAnchor number={21} /><DataTable columns={["Risk", "Type", "Severity", "Probability", "Description"]} rows={risks.map((risk) => [<div key="name" className="font-semibold">{String(risk.risk_name ?? "Risk")}</div>, cleanLabel(risk.risk_type), <StatusPill key="severity" value={risk.severity} />, cleanLabel(risk.probability), String(risk.description ?? "n/a")])} empty="No risks were persisted." /><DataTable columns={["Catalyst", "Type", "Expected date", "Impact", "Status"]} rows={catalysts.map((catalyst) => [<div key="name" className="font-semibold">{String(catalyst.catalyst_name ?? "Catalyst")}</div>, cleanLabel(catalyst.catalyst_type), String(catalyst.expected_date ?? "n/a"), <StatusPill key="status" value={catalyst.status} />])} empty="No catalysts were persisted." /></div><CanonicalAnchor number={24} /><SectionLink href={tabPath(assetId, "general", runId)} label="Return to the full report" /></SectionShell>;
}

function EvidenceSection({ assetId, runId, readModels, provenance }: { assetId: string; runId: string | null; readModels: AnyRecord; provenance: AnyRecord[] }) {
  const evidence = rows(readModels.evidence);
  const sources = rows(readModels.sources);
  const provenanceByClaim = new Map(provenance.map((item) => [String(item.claim_id ?? item.entity_id ?? ""), item]));
  return <SectionShell title="Evidence" description="Claims and the source documents attached to this run." icon={<ListChecks className="h-5 w-5" />}><CanonicalAnchor number={4} /><DataTable columns={["Claim", "Category", "Confidence", "Review", "Created", "Provenance"]} rows={evidence.map((claim) => { const source = provenanceByClaim.get(String(claim.id ?? "")); return [<div key="claim" className="max-w-2xl leading-6">{String(claim.claim_text ?? "Claim")}</div>, cleanLabel(claim.claim_category ?? claim.claim_type), formatPercent(claim.confidence), <StatusPill key="review" value={claim.review_status} />, formatDate(claim.created_at), <ProvenanceCell key="provenance" value={source} />]; })} empty="No evidence claims were persisted." /><div className="mt-5"><DataTable columns={["Source", "Publisher", "Date", "Status", "URI"]} rows={sources.map((source) => { const rawUri = source.uri ?? source.url ?? source.canonical_url; const uri = safeMarkdownHref(rawUri); return [<div key="title" className="font-semibold">{String(source.title ?? source.document_title ?? "Source")}</div>, String(source.publisher ?? source.source_name ?? "n/a"), String(source.document_date ?? source.published_at ?? "n/a"), <StatusPill key="status" value={source.ingest_status ?? source.status} />, uri ? <a key="uri" href={uri} target="_blank" rel="noreferrer" className="max-w-[260px] truncate text-sky-700 hover:text-sky-950">{uri}</a> : "n/a"]; })} empty="No source documents were attached." /></div><SectionLink href={tabPath(assetId, "general", runId)} label="Return to the full report" /></SectionShell>;
}

function BacktestsSection({ assetId, runId, readModels }: { assetId: string; runId: string | null; readModels: AnyRecord }) {
  const backtests = rows(readModels.backtests);
  return <SectionShell title="Backtests" description="Timing evidence and confidence checks for the selected run." icon={<Gauge className="h-5 w-5" />}><CanonicalAnchor number={23} /><DataTable columns={["Name", "Status", "Return", "Sharpe", "Max drawdown", "Period"]} rows={backtests.map((backtest) => { const metrics = asRecord(backtest.metrics_json); return [<div key="name" className="font-semibold">{String(backtest.name ?? backtest.strategy_name ?? "Backtest")}</div>, <StatusPill key="status" value={backtest.status} />, formatPercent(metrics.total_return), formatNumber(metrics.sharpe_ratio ?? metrics.sharpe), formatPercent(metrics.max_drawdown), `${String(backtest.start_date ?? "n/a")} to ${String(backtest.end_date ?? "n/a")}`]; })} empty="No backtest runs were persisted." /><SectionLink href={tabPath(assetId, "general", runId)} label="Return to the full report" /></SectionShell>;
}

function UpdatesSection({ assetId, runId, report, artifacts, runDetail, runs, missingSections }: { assetId: string; runId: string | null; report: AnyRecord; artifacts: AnyRecord[]; runDetail: AnyRecord | null; runs: AnyRecord[]; missingSections: AnyRecord[] }) {
  const schedule = asRecord(report.refresh_schedule?.content ?? report.refresh_schedule?.content_json);
  return <SectionShell title="Updates" description="Run history, monitoring trends, and open research work." icon={<RefreshCw className="h-5 w-5" />}><CanonicalAnchor number={22} /><MonitoringTrendTable dashboard={artifactContent(artifacts, "monitoring_dashboard")} /><div className="grid gap-5 lg:grid-cols-2"><section className="rounded-lg border border-slate-200 bg-white p-4"><h2 className="mb-3 text-sm font-bold">Run history</h2><div className="space-y-2">{runs.map((run) => <Link key={String(run.id)} href={tabPath(assetId, "general", String(run.id))} className="flex items-center justify-between gap-3 rounded-md border border-slate-100 px-3 py-2 text-xs hover:border-slate-300"><span><span className="font-mono text-slate-500">{shortId(run.id)}</span><span className="ml-2 font-semibold">{cleanLabel(run.run_type ?? "research")}</span></span><StatusPill value={run.status} /></Link>)}</div></section><section className="rounded-lg border border-slate-200 bg-white p-4"><h2 className="mb-3 text-sm font-bold">Monitoring context</h2><Info label="Current status" value={runDetail?.status} /><Info label="Next refresh" value={schedule.next_refresh_at ?? schedule.refresh_frequency ?? "Not scheduled"} />{missingSections.length > 0 && <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><strong>{missingSections.length} incomplete section(s)</strong> remain in this run.</div>}</section></div><CanonicalAnchor number={25} /><SectionLink href={tabPath(assetId, "general", runId)} label="Return to the full report" /></SectionShell>;
}

function MonitoringTrendTable({ dashboard }: { dashboard: AnyRecord }) {
  const items = rows(dashboard.items);
  if (!items.length) return <EmptyLine>No monitoring dashboard was persisted.</EmptyLine>;
  return <section className="space-y-3"><div><h3 className="text-sm font-bold text-slate-900">Monitoring dashboard</h3><p className="mt-0.5 text-xs text-slate-500">Latest four accepted observations, with thesis thresholds and affected model inputs.</p></div><DataTable columns={["KPI", "Q-3", "Q-2", "Q-1", "Latest", "Thresholds and model link"]} rows={items.map((item) => {
    const history = rows(item.history).slice(-4);
    const padded = [...Array(Math.max(0, 4 - history.length)).fill(null), ...history];
    return [<div key="kpi"><div className="font-semibold">{String(item.kpi)}</div><div className="mt-1 font-mono text-[10px] text-slate-400">{String(item.metric_key ?? "unmapped")}</div></div>, ...padded.map((point, index) => point ? <div key={index} className="min-w-24"><div className="font-mono tabular-nums">{formatRawMetricValue(point.value)}</div><div className="text-[10px] text-slate-400">{formatDate(point.period_end)} · {String(point.unit || "")}</div></div> : <span key={index} className="text-slate-300">—</span>), <div key="thresholds" className="min-w-48 text-xs"><div>Bear: {formatRawMetricValue(item.bear_threshold)} · Bull: {formatRawMetricValue(item.bull_threshold)}</div><div className="mt-1 text-slate-500">Base: {String(item.base_range)}</div><div className="mt-1 font-semibold text-slate-700">Affects {cleanLabel(item.model_input_affected)}</div></div>];
  })} /></section>;
}

function ExpectedReturnTable({ matrix }: { matrix: AnyRecord }) {
  const matrixRows = rows(matrix.rows);
  if (!matrixRows.length) return <EmptyLine>No reconciled expected-return matrix was persisted.</EmptyLine>;
  return <section className="space-y-3"><div><h3 className="text-sm font-bold text-slate-900">Expected-return matrix</h3><p className="mt-0.5 text-xs text-slate-500">Calculated from the accepted scenario targets and prediction price of {formatCurrency(matrix.prediction_price, matrix.currency)}.</p></div><DataTable columns={["Scenario", "Target date", "Target price", "Dividend", "Return", "Probability", "Weighted contribution"]} rows={matrixRows.map((row) => [<span key="scenario" className="font-semibold capitalize">{String(row.scenario_type)}</span>, String(row.target_date), formatCurrency(row.target_price, matrix.currency), formatCurrency(row.dividend_per_share, matrix.currency), formatPercent(row.total_return), formatPercent(row.probability), formatPercent(row.weighted_contribution)])} /><div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"><span className="font-semibold">Probability-weighted return:</span> <span className="ml-2 font-mono tabular-nums">{formatPercent(matrix.probability_weighted_return)}</span></div></section>;
}

function ValuationMethodBreakdown({ methodRun }: { methodRun: AnyRecord }) {
  const methods = rows(methodRun.methods);
  if (!methods.length) return <EmptyLine>No executable valuation-method breakdown was persisted.</EmptyLine>;
  return <div className="space-y-4">{methods.map((method, index) => <section key={String(method.method_key ?? index)} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-bold">{String(method.method_name ?? method.method_key)}</h3><p className="mt-1 max-w-4xl text-xs leading-5 text-slate-500">{String(method.rationale ?? "")}</p></div><StatusPill value={method.method_family} /></div><div className="mt-4 grid gap-4 xl:grid-cols-2"><DataTable columns={["Input", "Value", "Unit", "Source"]} rows={rows(method.inputs).map((input) => [String(input.key), formatRawMetricValue(input.value), String(input.unit ?? ""), cleanLabel(input.source)])} empty="No inputs." /><DataTable columns={["Calculation", "Operation", "Arguments", "Unit"]} rows={rows(method.formulas).map((formula) => [String(formula.label ?? formula.key), cleanLabel(formula.operation), Array.isArray(formula.args) ? formula.args.join(" × ") : "n/a", String(formula.unit ?? "")])} empty="No calculation rows." /></div><div className="mt-4"><DataTable columns={["Scenario", "Probability", "Per-share value", "Key overrides"]} rows={rows(method.scenarios).map((scenario) => [<span key="scenario" className="font-semibold capitalize">{String(scenario.scenarioType ?? scenario.scenario_type)}</span>, formatPercent(scenario.probability), formatCurrency(scenario.valueAnchor, "USD"), Object.entries(asRecord(scenario.overrides)).map(([key, value]) => `${cleanLabel(key)}: ${formatRawMetricValue(value)}`).join(" · ")])} /></div></section>)}</div>;
}

function SectionShell({ title, description, icon, children }: { title: string; description: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="space-y-5"><div><div className="flex items-center gap-2 text-slate-700">{icon}<h2 className="text-xl font-bold tracking-tight text-slate-950">{title}</h2></div><p className="mt-1 text-sm text-slate-500">{description}</p></div>{children}</div>;
}

function LiveBlock({ href, icon, label, value }: { href: string; icon: React.ReactNode; label: string; value: string }) {
  return <Link href={href} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-400"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">{icon}{label}</div><p className="mt-2 overflow-hidden text-sm font-semibold leading-5 text-slate-950" style={{ maxHeight: "3.75rem" }}>{value}</p><span className="mt-3 block text-[11px] font-semibold text-sky-700">Open section →</span></Link>;
}

function DataTable({ columns, rows: tableRows, empty = "No rows for this section." }: { columns: string[]; rows: Array<Array<React.ReactNode>>; empty?: string }) {
  if (tableRows.length === 0) return <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">{empty}</div>;
  return <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"><table className="min-w-full divide-y divide-slate-200 text-left text-sm"><thead className="bg-slate-50"><tr>{columns.map((column) => <th key={column} scope="col" className="whitespace-nowrap px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{column}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{tableRows.map((row, rowIndex) => <tr key={rowIndex} className="align-top">{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-[420px] px-3 py-3 leading-6 text-slate-700">{cell}</td>)}</tr>)}</tbody></table></div>;
}

function SectionLink({ href, label }: { href: string; label: string }) { return <Link href={href} className="inline-flex text-sm font-semibold text-sky-700 hover:text-sky-950">{label} →</Link>; }
function CanonicalAnchor({ number }: { number: number }) { return <span id={canonicalHeadingAnchor(number)} className="block scroll-mt-24" aria-hidden="true" />; }
function Info({ label, value }: { label: string; value: unknown }) { return <div className="rounded-md border border-slate-100 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div><div className="mt-1 text-sm leading-6 text-slate-700">{safeText(value)}</div></div>; }
function ProvenanceCell({ value }: { value: AnyRecord | undefined }) { if (!value) return <span className="text-slate-400">No linked source</span>; const locator = [value.page_start && `p. ${value.page_start}`, value.table_row && `row ${value.table_row}`, value.char_start != null && `chars ${value.char_start}–${value.char_end ?? "?"}`].filter(Boolean).join(" · "); return <div className="min-w-[220px] text-xs leading-5"><div className="font-semibold text-slate-800">{String(value.source_title ?? "Source location")}</div>{value.quote && <div className="mt-1 line-clamp-3 text-slate-600">“{String(value.quote)}”</div>}<div className="mt-1 text-slate-400">{locator || "Locator unavailable"}{value.as_of ? ` · as of ${formatDate(value.as_of)}` : ""}</div></div>; }
function EmptyLine({ children }: { children: React.ReactNode }) { return <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">{children}</div>; }
function EmptyState({ title, body, actionHref, actionLabel }: { title: string; body: string; actionHref?: string; actionLabel?: string }) { return <div className="rounded-xl border border-slate-200 bg-white p-10 text-center shadow-sm"><FileText className="mx-auto h-6 w-6 text-slate-400" /><h2 className="mt-3 text-base font-bold">{title}</h2><p className="mt-1 text-sm text-slate-500">{body}</p>{actionHref && actionLabel && <Link href={actionHref} className="mt-4 inline-flex rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">{actionLabel}</Link>}</div>; }
function PageState({ icon, title, body, actionLabel, onAction }: { icon?: React.ReactNode; title: string; body: string; actionLabel?: string; onAction?: () => void }) { return <div className="flex min-h-screen items-center justify-center bg-[#f6f8fb] px-5"><div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm"><div className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">{icon ?? <AlertTriangle className="h-4 w-4" />}</div><h1 className="mt-3 text-base font-bold">{title}</h1><p className="mt-1 text-sm leading-6 text-slate-500">{body}</p>{actionLabel && onAction && <button type="button" onClick={onAction} className="mt-4 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">{actionLabel}</button>}</div></div>; }
function StatusPill({ value }: { value: unknown }) { const label = cleanLabel(value); const tone = label.includes("complete") || label.includes("accepted") || label.includes("open") ? "border-emerald-200 bg-emerald-50 text-emerald-700" : label.includes("fail") || label.includes("error") ? "border-red-200 bg-red-50 text-red-700" : label.includes("pending") || label.includes("running") || label.includes("waiting") ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-slate-50 text-slate-600"; return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{label}</span>; }
async function fetchRequired<T>(url: string, signal?: AbortSignal): Promise<T> { const response = await fetch(url, { signal, cache: "no-store" }); if (!response.ok) { let message = `Request failed (${response.status})`; try { const body = await response.json(); if (body?.error) message = String(body.error); } catch { /* preserve status message */ } throw new Error(message); } return response.json() as Promise<T>; }
function rows(value: unknown): AnyRecord[] { return Array.isArray(value) ? value as AnyRecord[] : []; }
function asRecord(value: unknown): AnyRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {}; }
function artifactContent(artifacts: AnyRecord[], artifactType: string) { const artifact = artifacts.find((item) => String(item.type ?? item.artifact_type) === artifactType); return asRecord(artifact?.content ?? artifact?.content_json); }
function safeText(value: unknown, fallback = "n/a") { if (value === null || value === undefined || value === "") return fallback; if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return fallback; } }
function cleanLabel(value: unknown) { return safeText(value).replace(/_/g, " ").toLowerCase(); }
function shortId(value: unknown) { const text = safeText(value); return text.length > 8 ? text.slice(0, 8) : text; }
function formatDate(value: unknown) { if (!value) return "n/a"; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(); }
function formatNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: number >= 100 ? 0 : 3 }).format(number) : safeText(value); }
function displayMetricLabel(value: unknown) { const label = safeText(value).replace(/_/g, " "); return label.charAt(0).toUpperCase() + label.slice(1); }
function formatRawMetricValue(value: unknown) { if (value === null || value === undefined || value === "") return "—"; const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(number) : String(value); }
function formatCurrency(value: unknown, currency: unknown) { const number = Number(value); if (!Number.isFinite(number)) return safeText(value); return new Intl.NumberFormat("en-US", { style: "currency", currency: typeof currency === "string" && currency.length === 3 ? currency : "USD", maximumFractionDigits: number >= 100 ? 0 : 2 }).format(number); }
function formatPercent(value: unknown) { const number = Number(value); if (!Number.isFinite(number)) return safeText(value); return `${(Math.abs(number) <= 1 ? number * 100 : number).toFixed(1)}%`; }
function priceTargets(artifacts: AnyRecord[]) { const artifact = artifacts.find((item) => String(item.type ?? item.artifact_type) === "annual_price_target_path"); const content = asRecord(artifact?.content ?? artifact?.content_json); const values = content.price_target_path ?? content.price_target_paths ?? content.annual_price_targets; return Array.isArray(values) ? values as AnyRecord[] : []; }
function groupPriceTargets(values: AnyRecord[]) { const grouped = new Map<string, { year: string; bear: unknown; base: unknown; bull: unknown }>(); for (const value of values) { const year = String(value.fiscal_year ?? value.year ?? "unknown"); const row = grouped.get(year) ?? { year, bear: null, base: null, bull: null }; const scenario = String(value.scenario_type ?? value.scenario ?? "").toLowerCase(); const price = value.price_target ?? value.target ?? value.value_anchor; if (scenario === "bear" || scenario === "base" || scenario === "bull") row[scenario] = price; grouped.set(year, row); } return [...grouped.values()].sort((left, right) => left.year.localeCompare(right.year)); }
function chartConfig(assetId: string, runId: string | null, kind: ChartSeriesConfig["kind"], key: string, name: string, range: ChartViewConfig["range"]["preset"] = "1Y"): ChartViewConfig {
  const base = createDefaultChartViewConfig(assetId);
  return {
    ...base,
    name,
    runId: runId ?? undefined,
    range: { preset: range },
    series: [{ ...base.series[0], kind, key, runId: runId ?? undefined, label: name }],
  };
}

function createValuationChartConfig(assetId: string, runId: string | null, signals: AnyRecord[], scenarios: AnyRecord[]): ChartViewConfig {
  const numericSignal = signals.find((signal) => signal.current_value !== null && signal.current_value !== undefined && Number.isFinite(Number(signal.current_value)));
  if (numericSignal) return chartConfig(assetId, runId, "valuation", String(numericSignal.signal_key), "Valuation series");

  const base = createDefaultChartViewConfig(assetId);
  const scenarioTypes = ["bear", "base", "bull"].filter((type) => scenarios.some((scenario) => String(scenario.scenario_type).toLowerCase() === type));
  if (scenarioTypes.length === 0) return chartConfig(assetId, runId, "valuation", String(signals[0]?.signal_key ?? "current_value"), "Valuation series");
  return {
    ...base,
    name: "Valuation scenarios",
    runId: runId ?? undefined,
    display: "bar",
    series: scenarioTypes.map((type) => ({
      kind: "scenario" as const,
      assetId,
      key: type,
      runId: runId ?? undefined,
      label: `${type[0].toUpperCase()}${type.slice(1)} scenario`,
    })),
  };
}
