"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { runProgressIsLive } from "@/lib/research/run-polling";
import { ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
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

import styles from "./page.module.css";
import ui from "@/components/research-ui.module.css";
import { researchBriefAction } from "@/lib/research/brief-presentation";
import { ResearchReport } from "@/components/research-report";
import { FinancialStatements } from "@/components/financial-statements";
import { KPIDashboard } from '@/components/research-dashboards';
import { ResearchChat } from '@/components/research-chat';
import { artifactContent, researchObservations } from '@/lib/research/reporting/data-views';

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
  listings?: { symbol: string; is_primary: boolean }[];
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
  report: ResearchRecord | null;
  artifacts: ResearchRecord[];
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
  report: null,
  artifacts: [],
};

type TabId = "overview" | "evidence" | "metrics" | "valuation" | "thesis" | "financials" | "kpis" | "backtests" | "sources" | "runs";
const tabLabels: Partial<Record<TabId, string>> = { thesis: "Report", financials: "Financials", kpis: "KPIs", runs: "Run history" };
const tabLabel = (tab: TabId) => tabLabels[tab] ?? tab.charAt(0).toUpperCase() + tab.slice(1);
// Views that read large artifact bodies or the report document's artifacts. The others render from the summary report.
const fullReportTabs: readonly TabId[] = ["thesis", "financials", "kpis"];

const signalColors: Record<string, string> = {
  very_cheap: "#3d7664",
  cheap: "#689c89",
  neutral: "#64748b",
  expensive: "#b7893e",
  very_expensive: "#ae655c",
  inconclusive: "#94a3b8",
  not_applicable: "#cbd5e1",
};

export default function ViewResearchPage() {
  return <Suspense fallback={<div className={styles.message}>Loading research…</div>}><ViewResearch /></Suspense>;
}

function ViewResearch() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedRunId = searchParams.get("run");
  const requestedView = searchParams.get("view");
  const params = useParams();
  const assetId = String(params.id);
  const [data, setData] = useState<ResearchData>(emptyResearchData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeTab:TabId = requestedView === 'report' ? 'thesis' : ['evidence','metrics','valuation','financials','kpis','backtests','sources','runs'].includes(requestedView ?? '') ? requestedView as TabId : 'overview';
  const [searchQuery, setSearchQuery] = useState("");
  const loadVersion = useRef(0);
  // The run row behind the report on screen. A quiet refresh skips the report (megabytes) while that row is unchanged.
  const shownRun = useRef<ResearchRecord | null>(null);
  // Whether the report on screen is the full one. A quiet refresh keeps it while the run row is unchanged; once the
  // row changes, a refresh fetches what the current view needs, so Overview drops back to the summary.
  const shownFull = useRef(false);
  // The interval's loadResearch is from an earlier render, so it reads the current tab here.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [monitor, setMonitor] = useState<MonitorCheck | null>(null);
  // The stored monitor-check result; the check itself runs from npm run monitor:check, never from this page.
  useEffect(() => {
    fetch(`/api/assets/${assetId}/monitor`).then((res) => res.ok ? res.json() : null).then(setMonitor).catch(() => setMonitor(null));
  }, [assetId]);

  useEffect(() => {
    // Tab links pin ?run= to the run already on screen. That is navigation, not a new run, so keep the page mounted.
    if (requestedRunId && data.asset?.id === assetId && data.activeRun?.id === requestedRunId) return;
    void loadResearch();
    return () => { loadVersion.current++; };
  }, [assetId, requestedRunId]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadResearch(true); }, 60_000);
    return () => window.clearInterval(timer);
  }, [assetId, requestedRunId]);

  // Reads only the route, refs and state setters, so it changes only with the asset or the requested run.
  const loadResearch = useCallback(async (quiet = false) => {
    const version = ++loadVersion.current;
    if (!quiet) setLoading(true);
    setError(null);

    try {
      const [asset, runs] = await Promise.all([
        fetchJson<AssetDetail | null>(`/api/assets/${assetId}`, null),
        fetchJson<ResearchRecord[]>(`/api/assets/${assetId}/research-runs`, []),
      ]);

      const sortedRuns = [...runs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      if (version !== loadVersion.current) return;
      const targetRunId = requestedRunId;
      const activeRun = targetRunId ? sortedRuns.find((run) => run.id === targetRunId) : sortedRuns[0] ?? null;
      if (targetRunId && !activeRun) throw new Error("Research run not found.");

      if (!activeRun) {
        shownRun.current = null;
        shownFull.current = false;
        setData({ ...emptyResearchData, asset, runs: sortedRuns });
        return;
      }
      const shown = shownRun.current;
      const full = fullReportTabs.includes(activeTabRef.current);
      if (quiet && shown && shown.id === activeRun.id && shown.status === activeRun.status && (shownFull.current || !full)
        && String(shown.updated_at) === String(activeRun.updated_at) && !runProgressIsLive(String(activeRun.status))) {
        setData((current) => ({ ...current, asset, runs: sortedRuns, activeRun }));
        return;
      }

      const runId = activeRun.id;
      const [runDetail, report] = await Promise.all([
        fetchJson<ResearchRecord | null>(`/api/research-runs/${runId}`, null),
        fetchJson<ResearchRecord | null>(`/api/research-runs/${runId}/report${full ? "" : "?summary=1"}`, null),
      ]);
      const readModels = report?.read_models ?? {};
      const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : [];
      const evidence = Array.isArray(readModels.evidence) ? readModels.evidence : [];
      const metrics = Array.isArray(readModels.metrics) ? readModels.metrics : [];
      const signals = Array.isArray(readModels.valuation_signals) ? readModels.valuation_signals : [];
      const scenarios = Array.isArray(readModels.scenarios) ? readModels.scenarios : [];
      const theses = Array.isArray(readModels.theses) ? readModels.theses : [];
      const risks = Array.isArray(readModels.risks) ? readModels.risks : [];
      const catalysts = Array.isArray(readModels.catalysts) ? readModels.catalysts : [];
      const backtests = Array.isArray(readModels.backtests) ? readModels.backtests : [];
      const sources = Array.isArray(readModels.sources) ? readModels.sources : [];
      const modelCalls = Array.isArray(readModels.model_calls) ? readModels.model_calls : [];

      if (version !== loadVersion.current) return;
      shownRun.current = activeRun;
      shownFull.current = full;
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
        report,
        artifacts,
      });
    } catch (loadError) {
      if (version !== loadVersion.current) return;
      console.error(loadError);
      if (!quiet) setError(loadError instanceof Error ? loadError.message : "Unable to load research");
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [assetId, requestedRunId]);

  // The Report, Financials and KPI views need the full report; the page opened with the summary loads it on first use.
  const needsFullReport = Boolean(data.report?.summary) && fullReportTabs.includes(activeTab);
  useEffect(() => {
    if (needsFullReport && !loading && !error) void loadResearch();
  }, [needsFullReport, loading, error, loadResearch]);

  const filtered = useMemo(() => filterResearch(data, searchQuery), [data, searchQuery]);
  const content = (type: string) => {
    const artifact = data.artifacts.find((item) => (item.type ?? item.artifact_type) === type);
    return asRecord(artifact?.content_json);
  };
  const thesis = content("investment_thesis");
  const conditions = Array.isArray(thesis.must_be_true) ? thesis.must_be_true.filter((value): value is string => typeof value === "string") : [];
  const riskContent = content("risk_register");
  const risks = Array.isArray(riskContent.risks) ? riskContent.risks.map(asRecord) : [];
  const targets = content("annual_price_target_path");
  const targetRows = [targets.price_target_path, targets.price_target_paths, targets.annual_price_targets].find(Array.isArray) as ResearchRecord[] | undefined;
  const run = data.activeRun ? { ...data.activeRun, ...data.runDetail } : null;
  const action = researchBriefAction(run ? { id: String(run.id), status: String(run.status), stages: run.stages } : null, assetId);
  const valuationChartData = data.signals
    .filter((signal) => signal.cheapness_score != null && Number.isFinite(Number(signal.cheapness_score)))
    .map((signal) => ({ name: shortLabel(signal.signal_name || signal.signal_key || "Signal", 18), score: Number(signal.cheapness_score), signal: signal.signal }));

  function openSection(section: TabId) {
    setSearchQuery("");
    router.push(sectionHref(section));
    window.scrollTo({ top: 0 });
  }

  function sectionHref(section:TabId, runId?:string) {
    const query = new URLSearchParams(searchParams.toString());
    query.set('view',section === 'thesis' ? 'report' : section);
    if (runId ?? data.activeRun?.id) query.set('run',runId ?? data.activeRun!.id);
    return `/assets/${assetId}/view?${query}`;
  }

  if (loading || (!error && needsFullReport) || (!error && data.asset && (data.asset.id !== assetId || (requestedRunId && data.activeRun?.id !== requestedRunId)))) return <div className={styles.message} role="status"><RefreshCw size={16} className="animate-spin" />Loading research…</div>;
  if (error || !data.asset) return <div className={styles.message} role="alert">{error ?? "Asset not found."}<button onClick={()=>void loadResearch()}>Try again</button></div>;

  const asset = data.asset;
  const currency = targets.currency ?? asset.base_currency;
  const header = <>
    <header className={ui.heading}>
      <div className={ui.titleGroup}>
        <h1>{asset.canonical_name}</h1>
        <span className={ui.muted}>{[(asset.listings?.find((item) => item.is_primary) ?? asset.listings?.[0])?.symbol, cleanWords(asset.asset_kind.replace(/_asset/g, "")), asset.sector].filter(Boolean).join(" · ")}</span>
        {activeTab !== "thesis" && <span className={ui.status} data-status={action.tone}>{action.label}</span>}
      </div>
      <div className={ui.headActions}>
        <Link href={`/assets/${assetId}`} className={ui.secondary}>Asset details</Link>
        {data.activeRun&&<ResearchChat key={data.activeRun.id} runId={data.activeRun.id} evidence={data.report?.report_document?.evidence??[]}/>}
        <Link href={`/assets/${assetId}/run?new=1`} className={ui.primary}>New research</Link>
      </div>
    </header>
    <AssetTabs activeTab={activeTab} hrefFor={sectionHref} />
  </>;
  const viewArtifacts = [...data.artifacts, ...(data.report?.report_document?.artifacts ?? []).filter((a:ResearchRecord)=>!data.artifacts.some(b=>b.id===a.id))];
  const view = (body: React.ReactNode, wrap = false) => <div className={ui.page}>{header}<div key={activeTab}>
    {activeTab !== "overview" && <h2 className="sr-only">{tabLabel(activeTab)}</h2>}
    {wrap ? <section className={`${ui.tile} ${styles.wide}`}>{body}</section> : body}
  </div></div>;
  if (activeTab === 'kpis') return view(<KPIDashboard key={data.activeRun?.id} artifacts={viewArtifacts} onRefresh={()=>void loadResearch()} refreshing={loading}/>, true);
  if (activeTab === 'thesis' && data.report?.report_document) return view(<ResearchReport key={data.activeRun?.id} document={data.report.report_document} liveArtifacts={viewArtifacts} financialsHref={sectionHref('financials')}/>);
  if (activeTab === 'financials') {
    const observations = researchObservations(viewArtifacts);
    return view(<FinancialStatements key={data.activeRun?.id} observations={observations} filingTables={artifactContent(viewArtifacts,'financial_statement_set').tables??[]} sources={data.sources} evidence={[...(data.report?.report_document?.evidence??[]),...data.evidence]} isTest={data.report?.report_document?.is_test}/>, true);
  }

  if (activeTab === "overview") return view(!data.activeRun ? <section className={ui.tile}>
    <div className={ui.tileHead}><h2>No research yet</h2></div>
    <div className={`${ui.tileBody} flex flex-wrap items-center justify-between gap-3`}><p className={ui.muted}>Start a run to build the thesis, valuation and risk register for this asset.</p><Link className={ui.primary} href={action.href}>{action.action}</Link></div>
  </section> : <div className={ui.grid} key={data.activeRun.id}>
    <section className={`${ui.tile} ${ui.s8}`}>
      <div className={ui.tileHead}><h2>Thesis</h2><button className={ui.textLink} onClick={() => openSection("thesis")}>Full report</button></div>
      <div className={ui.tileBody}>
        <p className={ui.lead}>{safeText(thesis.thesis_statement ?? thesis.thesis ?? thesis.investment_thesis, "The research summary is not available yet.")}</p>
        {conditions.length > 0 && <><h3 className="mt-4 mb-2 text-[12px] font-semibold text-[var(--ink-2)]">Must be true</h3><ul>{conditions.slice(0, 4).map((condition) => <li key={condition}>{condition}</li>)}</ul></>}
        {(conditions.length > 4 || typeof thesis.causal_chain === "string" || typeof thesis.market_mispricing === "string") && <details className={styles.more}>
          <summary>Read more</summary>
          {conditions.length > 4 && <ul>{conditions.slice(4).map((condition) => <li key={condition}>{condition}</li>)}</ul>}
          {typeof thesis.causal_chain === "string" && <p>{thesis.causal_chain}</p>}
          {typeof thesis.market_mispricing === "string" && <p>{thesis.market_mispricing}</p>}
        </details>}
      </div>
    </section>
    <section className={`${ui.tile} ${ui.s4}`}>
      <div className={ui.tileHead}><h2>Status</h2><span className={ui.status} data-status={action.tone}>{action.label}</span></div>
      <dl className={ui.kv}>
        <dt>Run</dt><dd>{cleanWords(data.activeRun.run_type)}</dd>
        <dt>Run id</dt><dd className={ui.mono}>{shortId(data.activeRun.id)}</dd>
        <dt>Started</dt><dd>{formatDate(data.activeRun.created_at)}</dd>
        <dt>Monitor</dt><dd>{monitor ? monitorLabel(monitor) : "Not checked"}</dd>
      </dl>
      {data.report?.incomplete && <details className={`${styles.missing} px-3.5`}>
        <summary>Research incomplete<ChevronDown size={14} /></summary>
        <ul>{(data.report.missing_sections ?? []).map((item: ResearchRecord) => <li key={item.type}>{item.label}</li>)}</ul>
      </details>}
      <div className={ui.actions}><button className={ui.textLink} onClick={() => openSection("evidence")}>Evidence</button><Link className={ui.primary} href={action.href}>{action.action}</Link></div>
    </section>
    <section className={`${ui.tile} ${ui.s6}`}>
      <div className={ui.tileHead}><h2>Annual price targets</h2><button className={ui.textLink} onClick={() => openSection("valuation")}>Valuation details</button></div>
      {targetRows?.length ? <div className={ui.table}><table>
        <thead><tr><th>Year</th><th className={ui.num}>Bear</th><th className={ui.num}>Base</th><th className={ui.num}>Bull</th></tr></thead>
        <tbody>{groupPriceTargets(targetRows).map((row) => <tr key={row.year}><td>{row.year}</td><td className={ui.num}>{formatCurrency(row.bear, currency)}</td><td className={`${ui.num} font-medium`}>{formatCurrency(row.base, currency)}</td><td className={ui.num}>{formatCurrency(row.bull, currency)}</td></tr>)}</tbody>
      </table></div> : <p className={ui.empty}>No annual price targets yet.</p>}
    </section>
    <section className={`${ui.tile} ${ui.s6}`}>
      <div className={ui.tileHead}><h2>Open questions</h2><span className={ui.muted}>{risks.length}</span></div>
      {risks.length ? <div>{risks.slice(0, 5).map((risk, index) => <RiskQuestion key={index} risk={risk} />)}
        {risks.length > 5 && <details className={styles.moreRisks}><summary>All {risks.length} risks<ChevronDown size={14} /></summary>{risks.slice(5).map((risk, index) => <RiskQuestion key={index} risk={risk} />)}</details>}
      </div> : <p className={ui.empty}>No risk register yet.</p>}
    </section>
  </div>);

  return view(<section className={ui.tile}>
    {activeTab !== "runs" && !(activeTab === "thesis" && data.report?.report_document) && <div className={ui.toolbar}><div className={ui.search}><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search this section" placeholder="Search this section" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /></div></div>}
    <div className={styles.supporting}>
      {activeTab === "evidence" && <EvidenceSection evidence={filtered.evidence} />}
      {activeTab === "metrics" && <MetricsSection metrics={filtered.metrics} />}
      {activeTab === "valuation" && <ValuationSection signals={filtered.signals} scenarios={filtered.scenarios} valuationChartData={valuationChartData} />}
      {activeTab === "thesis" && (data.report?.report_document ? <ResearchReport document={data.report.report_document} /> : <><CanonicalReportSummary report={data.report} artifacts={data.artifacts} /><ThesisSection theses={filtered.theses} risks={filtered.risks} catalysts={filtered.catalysts} /></>)}
      {activeTab === "backtests" && <BacktestsSection backtests={filtered.backtests} />}
      {activeTab === "sources" && <SourcesSection sources={filtered.sources} modelCalls={filtered.modelCalls} runDetail={data.runDetail} />}
      {activeTab === "runs" && <RunHistory runs={data.runs} activeRun={data.activeRun} stages={data.runDetail?.stages ?? []} assetId={assetId} onSelect={(id) => router.push(sectionHref("runs", id))} />}
    </div>
  </section>);
}

function RunHistory({ runs, activeRun, stages, assetId, onSelect }: { runs: ResearchRecord[]; activeRun: ResearchRecord | null; stages: ResearchRecord[]; assetId: string; onSelect: (id: string) => void }) {
  return <>
    <div className={ui.tileHead}><h2>Runs</h2><span className={ui.muted}>{runs.length}</span></div>
    <div className={ui.table}><table>
      <thead><tr><th>Run</th><th>Started</th><th>Id</th><th>Status</th><th className={ui.num}><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{runs.map((item) => <tr key={item.id} className={item.id === activeRun?.id ? "bg-[#f9fafb]" : undefined}>
        <td><button className="font-medium hover:underline" aria-current={item.id === activeRun?.id ? "true" : undefined} onClick={() => onSelect(item.id)}>{cleanWords(item.run_type)}</button></td>
        <td>{formatDate(item.created_at)}</td><td className={ui.mono}>{shortId(item.id)}</td>
        <td><span className={ui.status} data-status={item.status}>{cleanWords(item.status)}</span></td>
        <td className={ui.num}><Link className={ui.textLink} href={`/assets/${assetId}/run?run=${item.id}`}>Open run</Link></td>
      </tr>)}</tbody>
    </table></div>
    <div className={ui.tileHead}><h2>Stages for {activeRun ? shortId(activeRun.id) : "this run"}</h2><span className={ui.muted}>{stages.length}</span></div>
    <DataTable columns={["Stage", "Status"]} rows={stages.map((stage: ResearchRecord) => [cleanWords(stage.stage_name ?? stage.stage_key), <span key="s" className={ui.status} data-status={stage.status}>{cleanWords(stage.status)}</span>])} />
  </>;
}

const tabViews: TabId[] = ["overview", "thesis", "financials", "kpis", "valuation", "evidence", "metrics", "backtests", "sources", "runs"];

function AssetTabs({ activeTab, hrefFor }: { activeTab: TabId; hrefFor: (view: TabId) => string }) {
  return <nav aria-label="Asset views" className={styles.tabs}>
    {tabViews.map((view) => <Link key={view} href={hrefFor(view)} aria-current={activeTab === view ? "page" : undefined}>{tabLabel(view)}</Link>)}
  </nav>;
}

interface MonitorCheck { status: string; refresh_due: boolean; reasons: string[]; checked_at: string; newer_run: boolean; }

function monitorLabel(monitor: MonitorCheck) {
  if (monitor.refresh_due) return "Refresh due";
  return monitor.status === "current" ? "No refresh due" : monitor.status === "skipped" ? "Not checked" : "Check failed";
}

function cleanWords(value: unknown) {
  const text = cleanLabel(value);
  return text === "n/a" ? text : text.replace(/^./, (c) => c.toUpperCase());
}

function RiskQuestion({ risk }: { risk: JsonRecord }) {
  return <details className={styles.question}>
    <summary>{safeText(risk.risk_name, "Risk")}<ChevronRight size={14} /></summary>
    <div><p>{safeText(risk.causal_mechanism ?? risk.description)}</p>
      {typeof risk.leading_indicator === "string" && <p>{risk.leading_indicator}</p>}
      {typeof risk.failure_threshold === "string" && <p>{risk.failure_threshold}</p>}
    </div>
  </details>;
}

function CanonicalReportSummary({ report, artifacts }: { report: ResearchRecord | null; artifacts: ResearchRecord[] }) {
  const byType = new Map<string, ResearchRecord>();
  for (const artifact of artifacts) {
    if (!byType.has(String(artifact.type || artifact.artifact_type))) byType.set(String(artifact.type || artifact.artifact_type), artifact);
  }
  const content = (type: string) => asRecord(byType.get(type)?.content_json);
  const genesis = content("company_genesis");
  const founder = content("founder_profile");
  const thesis = content("investment_thesis");
  const targetContent = content("annual_price_target_path");
  const targetRows = Array.isArray(targetContent.price_target_path)
    ? targetContent.price_target_path as ResearchRecord[]
    : Array.isArray(targetContent.price_target_paths)
    ? targetContent.price_target_paths as ResearchRecord[]
    : Array.isArray(targetContent.annual_price_targets)
      ? targetContent.annual_price_targets as ResearchRecord[]
      : [];
  const missing = Array.isArray(report?.missing_sections) ? report.missing_sections : [];
  return <>
    <details className={ui.section} open><summary>Investment thesis</summary><div className={ui.sectionBody}>
      {Object.keys(thesis).length ? <LongText value={thesis.thesis || thesis.investment_thesis || thesis.thesis_statement} /> : <IncompleteState label="Investment thesis" />}
    </div></details>
    {missing.length > 0 && <details className={ui.section}><summary>Incomplete sections <span className={ui.muted}>{missing.length}</span></summary><ul className={ui.sectionBody}>{missing.map((item: ResearchRecord) => <li key={item.type}>{item.label}</li>)}</ul></details>}
    <details className={ui.section}><summary>Company origins</summary><div className={ui.sectionBody}>
      {Object.keys(genesis).length || Object.keys(founder).length ? <>
        <InsightBlock label="Why the company started" value={genesis.customer_problem || genesis.pre_founding_environment || genesis.original_product} />
        <InsightBlock label="Founder background" value={founder.background_summary || founder.motivations || genesis.founder_background || genesis.founder_motivations} />
        <InsightBlock label="Strategic implications" value={genesis.present_day_implications || genesis.current_strategic_implication} />
      </> : <IncompleteState label="Company origins" />}
    </div></details>
    <details className={ui.section}><summary>Annual price targets</summary><div className={ui.sectionBody}>
      {targetRows.length ? <div className={ui.table}><table><thead><tr><th>Fiscal year</th><th>Bear</th><th>Base</th><th>Bull</th></tr></thead><tbody>
        {groupPriceTargets(targetRows).map((row) => <tr key={row.year}><td>{row.year}</td><td>{formatCurrency(row.bear, "USD")}</td><td>{formatCurrency(row.base, "USD")}</td><td>{formatCurrency(row.bull, "USD")}</td></tr>)}
      </tbody></table></div> : <IncompleteState label="Annual price target path" />}
    </div></details>
  </>;
}

function IncompleteState({ label }: { label: string }) {
  return <div className="rounded-md border border-dashed border-amber-200 bg-amber-50/50 px-3 py-3 text-sm text-amber-800">{label} is incomplete: no canonical artifact was persisted.</div>;
}

function groupPriceTargets(rows: ResearchRecord[]) {
  const grouped = new Map<string, { year: string; bear: unknown; base: unknown; bull: unknown }>();
  for (const row of rows) {
    const year = String(row.fiscal_year ?? row.year ?? row.fiscalYear ?? "unknown");
    const item = grouped.get(year) || { year, bear: null, base: null, bull: null };
    const scenario = String(row.scenario_type ?? row.scenario ?? "").toLowerCase();
    const value = row.price_target ?? row.target ?? row.value_anchor ?? null;
    if (scenario === "bear") item.bear = value;
    if (scenario === "base") item.base = value;
    if (scenario === "bull") item.bull = value;
    grouped.set(year, item);
  }
  return [...grouped.values()].sort((a, b) => a.year.localeCompare(b.year));
}

function EvidenceSection({ evidence }: { evidence: ResearchRecord[] }) {
  return (
    <section className={styles.dataSection}>
      <SectionHeader title="Evidence claims" count={evidence.length} />
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
    <div className="flex flex-col">
      <details className={ui.section} open><summary>Metric comparison</summary>
        <div className="h-[420px] p-3.5">
          <MetricBarChart metrics={metrics} />
        </div>
      </details>

      <section className={styles.dataSection}>
        <SectionHeader title="Metric observations" count={metrics.length} />
        <DataTable
          columns={["Metric", "Value", "Period", "Provider", "Confidence", "Review"]}
          rows={metrics.map((metric) => [
            <div key="metric" className="min-w-[220px]">
              <div className="font-medium">
                {metric.metric_display_name ?? metric.metric_key ?? shortId(metric.metric_definition_id)}
              </div>
              <div className={ui.mono}>{metric.metric_category ?? "uncategorized"}</div>
            </div>,
            formatMetricValue(metric),
            formatDate(metric.period_end ?? metric.as_of_date),
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
    <div className="flex flex-col">
      <div className="flex flex-col">
        <section className={styles.dataSection}>
          <SectionHeader title="Cheapness scores" count={valuationChartData.length} />
          <div className="h-[360px] p-3.5">
            <ValuationScoreChart data={valuationChartData} />
          </div>
        </section>

        <section className={styles.dataSection}>
          <SectionHeader title="Valuation signals" count={signals.length} />
          <DataTable
            columns={["Signal", "Lens", "Current", "Cheapness", "Call", "Confidence"]}
            rows={signals.map((signal) => [
              <div key="signal" className="min-w-[220px]">
                <div className="font-medium">{signal.signal_name}</div>
                <div className={ui.mono}>{signal.signal_key}</div>
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

      <section className={styles.dataSection}>
        <SectionHeader title="Scenarios" count={scenarios.length} />
        <DataTable
          columns={["Scenario", "Type", "Probability", "Value Anchor", "Assumptions", "Review"]}
          rows={scenarios.map((scenario) => [
            <div key="scenario" className="min-w-[180px] font-medium">
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
    <div>
      {theses.length === 0 ? (
        <EmptyState title="No thesis records" body="This run has not stored a thesis yet." />
      ) : (
        theses.map((thesis) => (
          <details key={thesis.id} className={ui.section}><summary>Thesis notes</summary><div className={ui.sectionBody}>
            <p className={ui.lead}>
              {thesis.one_sentence_thesis}
            </p>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
              <InsightBlock label="Why now" value={thesis.why_now} />
              <InsightBlock label="Market missing" value={thesis.market_missing} />
            </div>
            <div className="mt-3">
              <SectionHeader title="Drivers" count={thesis.drivers?.length ?? 0} compact />
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
          </div></details>
        ))
      )}

      <details className={ui.section}><summary>Risks <span className={ui.muted}>{risks.length}</span></summary><div className={ui.sectionBody}>
        <DataTable
          columns={["Risk", "Type", "Severity", "Probability", "Description", "Mitigants"]}
          rows={risks.map((risk) => [
            <div key="risk" className="min-w-[180px] font-medium">
              {risk.risk_name}
            </div>,
            cleanLabel(risk.risk_type),
            <SeverityPill key="severity" value={risk.severity} />,
            cleanLabel(risk.probability),
            <LongText key="description" value={risk.description} />,
            <JsonPreview key="mitigants" value={risk.mitigants_json} />,
          ])}
        />
      </div></details>

      <details className={ui.section}><summary>Catalysts <span className={ui.muted}>{catalysts.length}</span></summary><div className={ui.sectionBody}>
        <DataTable
          columns={["Catalyst", "Type", "Expected Date", "Impact", "Status", "Description"]}
          rows={catalysts.map((catalyst) => [
            <div key="catalyst" className="min-w-[180px] font-medium">
              {catalyst.catalyst_name}
            </div>,
            cleanLabel(catalyst.catalyst_type),
            catalyst.expected_date ?? "n/a",
            cleanLabel(catalyst.upside_downside),
            <StatusPill key="status" value={catalyst.status} />,
            <LongText key="description" value={catalyst.description} />,
          ])}
        />
      </div></details>
    </div>
  );
}

function BacktestsSection({ backtests }: { backtests: ResearchRecord[] }) {
  return (
    <section className={styles.dataSection}>
      <SectionHeader title="Backtests" count={backtests.length} />
      <DataTable
        columns={["Name", "Status", "Return", "Sharpe", "Max Drawdown", "Period", "Metrics"]}
        rows={backtests.map((backtest) => {
          const metrics = asRecord(backtest.metrics_json);
          return [
            <div key="name" className="min-w-[220px]">
              <div className="font-medium">{backtest.name ?? backtest.strategy_name ?? "Backtest"}</div>
              <div className={ui.mono}>{shortId(backtest.id)}</div>
            </div>,
            <StatusPill key="status" value={backtest.status} />,
            formatPercent(metrics.total_return),
            formatNumber(metrics.sharpe_ratio ?? metrics.sharpe),
            formatPercent(metrics.max_drawdown),
            `${formatDate(backtest.start_date)} to ${formatDate(backtest.end_date)}`,
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
    <div className="flex flex-col">
      <section className={styles.dataSection}>
        <SectionHeader title="Source documents" count={sources.length} />
        <DataTable
          columns={["Source", "Publisher", "Date", "Ingest", "Trust", "URI"]}
          rows={sources.map((source) => [
            <div key="source" className="min-w-[240px]">
              <div className="font-medium">{source.title ?? source.document_title ?? "Source"}</div>
              <div className={ui.mono}>{source.source_type ?? source.document_type}</div>
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
                className={`${ui.textLink} max-w-[260px] truncate`}
              >
                {String(source.uri)}
              </a>
            ) : (
              "n/a"
            ),
          ])}
        />
      </section>

      <section className={styles.dataSection}>
        <SectionHeader title="Pipeline stages" count={runDetail?.stages?.length ?? 0} />
        <DataTable
          columns={["Stage", "Status", "Started", "Completed", "Notes"]}
          rows={(runDetail?.stages ?? []).map((stage: ResearchRecord) => [
            <div key="stage" className="min-w-[220px] font-medium">
              {stage.stage_name ?? stage.stage_key}
            </div>,
            <StatusPill key="status" value={stage.status} />,
            formatDateTime(stage.started_at),
            formatDateTime(stage.completed_at),
            <LongText key="notes" value={stage.error_message ?? stage.skip_reason ?? stage.notes} />,
          ])}
        />
      </section>

      <section className={styles.dataSection}>
        <SectionHeader title="Model calls" count={modelCalls.length} />
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
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eef0f3" />
        <XAxis type="number" tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis dataKey="name" type="category" width={120} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <Tooltip
          cursor={{ fill: "#f1f5f9" }}
          formatter={(value) => formatNumber(value)}
          contentStyle={{ borderRadius: 8, borderColor: "#e2e8f0", fontSize: 12 }}
        />
        <Bar dataKey="value" fill="#2e5fa3" radius={[0, 4, 4, 0]} />
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
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
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

function DataTable({ columns, rows }: { columns: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <div className={ui.empty}>No rows for this section.</div>;
  return <div className={ui.table}><table>
    <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
    <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
}

function SectionHeader({ title, count }: { title: string; count: number; compact?: boolean }) {
  return <div className={ui.tileHead}><h2>{title}</h2><span className={ui.muted}>{count}</span></div>;
}

function InsightBlock({ label, value }: { label: string; value: unknown }) {
  return <div className="py-2"><div className="mb-1 text-[12px] font-semibold text-[var(--ink-2)]">{label}</div><p>{safeText(value)}</p></div>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className={ui.empty}><p className="font-medium text-[var(--ink)]">{title}</p><p>{body}</p></div>;
}

function EmptyChart({ label }: { label: string }) {
  return <div className={`${ui.muted} flex h-full items-center justify-center`}>{label}</div>;
}

function LongText({ value }: { value: unknown }) {
  return <div className={styles.longText}>{safeText(value)}</div>;
}

function JsonPreview({ value }: { value: unknown }) {
  return <details className="max-w-[420px]"><summary className={ui.textLink}>Details</summary><div className="mt-2 whitespace-normal break-words">{stringifyCompact(value)}</div></details>;
}

function StatusPill({ value }: { value: unknown }) {
  const label = cleanLabel(value);
  const status = label.includes("complete") || label.includes("accepted") ? "completed" : label.includes("fail") || label.includes("error") || label.includes("reject") ? "failed" : label.includes("pending") || label.includes("running") ? "pending" : "";
  return <span className={ui.status} data-status={status}>{cleanWords(value)}</span>;
}

function SignalPill({ value }: { value: unknown }) {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: signalColors[String(value)] ?? "#64748b" }} />{cleanWords(value)}</span>;
}

function SeverityPill({ value }: { value: unknown }) {
  const label = cleanLabel(value);
  const status = label.includes("high") || label.includes("severe") || label.includes("critical") ? "failed" : label.includes("medium") || label.includes("moderate") ? "pending" : "";
  return <span className={ui.status} data-status={status}>{cleanWords(value)}</span>;
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404) return fallback;
    throw new Error("Unable to load research. Please try again.");
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
  if (value === null || value === undefined || value === "") return "n/a";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return safeText(value);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: numberValue >= 100 ? 0 : 3,
  }).format(numberValue);
}

function formatCurrency(value: unknown, currency: unknown) {
  if (value === null || value === undefined || value === "") return "n/a";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return safeText(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: typeof currency === "string" && currency.length === 3 ? currency : "USD",
    maximumFractionDigits: numberValue >= 100 ? 0 : 2,
  }).format(numberValue);
}

function formatPercent(value: unknown) {
  if (value === null || value === undefined || value === "") return "n/a";
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
