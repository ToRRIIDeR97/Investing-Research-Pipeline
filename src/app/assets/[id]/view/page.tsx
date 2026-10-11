"use client";

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  MoreHorizontal,
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
type NavDirection = "forward" | "back";

const navViews = ["overview", "thesis", "financials", "kpis"] as const;
const tabLabels: Partial<Record<TabId, string>> = { thesis: "Report", financials: "Financials", kpis: "KPI Dashboard", runs: "Run history" };
const tabLabel = (tab: TabId) => tabLabels[tab] ?? tab.charAt(0).toUpperCase() + tab.slice(1);
// Position in the asset nav. Views opened from the Overview menu sit between Overview and Report.
const tabOrder = (tab: TabId) => { const index = (navViews as readonly TabId[]).indexOf(tab); return index >= 0 ? index : 0.5; };

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
  const menu = useRef<HTMLDetailsElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const loadVersion = useRef(0);
  // Slide direction for the tab content: from the side of the newly selected tab.
  const [tabMotion, setTabMotion] = useState<{ tab: TabId; direction?: NavDirection }>({ tab: activeTab });
  if (tabMotion.tab !== activeTab) setTabMotion({ tab: activeTab, direction: tabOrder(activeTab) >= tabOrder(tabMotion.tab) ? "forward" : "back" });

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

  async function loadResearch(quiet = false) {
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
        setData({ ...emptyResearchData, asset, runs: sortedRuns });
        return;
      }

      const runId = activeRun.id;
      const [runDetail, report] = await Promise.all([
        fetchJson<ResearchRecord | null>(`/api/research-runs/${runId}`, null),
        fetchJson<ResearchRecord | null>(`/api/research-runs/${runId}/report`, null),
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
  }

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
    if (menu.current) menu.current.open = false;
    window.scrollTo({ top: 0 });
  }

  function sectionHref(section:TabId, runId?:string) {
    const query = new URLSearchParams(searchParams.toString());
    query.set('view',section === 'thesis' ? 'report' : section);
    if (runId ?? data.activeRun?.id) query.set('run',runId ?? data.activeRun!.id);
    return `/assets/${assetId}/view?${query}`;
  }

  if (loading || (!error && data.asset && (data.asset.id !== assetId || (requestedRunId && data.activeRun?.id !== requestedRunId)))) return <div className={styles.message} role="status"><RefreshCw size={18} className="animate-spin" />Loading research…</div>;
  if (error || !data.asset) return <div className={styles.message} role="alert">{error ?? "Asset not found."}<button onClick={()=>void loadResearch()}>Try again</button></div>;

  const navigation = <div className={styles.assetNavigation}>
    <Link className={styles.assetName} href={`/assets/${assetId}`}>{data.asset.canonical_name}</Link>
    <AssetTabs activeTab={activeTab} hrefFor={sectionHref} />
    <Link href={`/assets/${assetId}/run?new=1`} className={styles.newResearch}>New research</Link>
    {data.activeRun&&<ResearchChat key={data.activeRun.id} runId={data.activeRun.id} evidence={data.report?.report_document?.evidence??[]}/>}
  </div>;
  const viewArtifacts = [...data.artifacts, ...(data.report?.report_document?.artifacts ?? []).filter((a:ResearchRecord)=>!data.artifacts.some(b=>b.id===a.id))];
  // The nav bar is the header: each view keeps one visually hidden h1 and no visible title.
  const view = (body: React.ReactNode) => <>{navigation}<div key={activeTab} data-nav-direction={tabMotion.direction}>
    <h1 className="sr-only">{activeTab === "overview" ? data.asset!.canonical_name : `${data.asset!.canonical_name}: ${tabLabel(activeTab)}`}</h1>
    {body}
  </div></>;
  if (activeTab === 'kpis') return view(<KPIDashboard key={data.activeRun?.id} artifacts={viewArtifacts} onRefresh={()=>void loadResearch()} refreshing={loading}/>);
  if (activeTab === 'thesis' && data.report?.report_document) return view(<ResearchReport key={data.activeRun?.id} document={data.report.report_document} liveArtifacts={viewArtifacts} onBack={()=>openSection('overview')} financialsHref={sectionHref('financials')}/>);
  if (activeTab === 'financials') {
    const observations = researchObservations(viewArtifacts);
    return view(<FinancialStatements key={data.activeRun?.id} observations={observations} filingTables={artifactContent(viewArtifacts,'financial_statement_set').tables??[]} sources={data.sources} evidence={[...(data.report?.report_document?.evidence??[]),...data.evidence]} isTest={data.report?.report_document?.is_test}/>);
  }

  return view(
    <div className={activeTab === "overview" ? styles.brief : styles.detailPage}>
      <div className={styles.toolbar}>
        {activeTab === "overview" ? <Link href="/assets"><ArrowLeft size={16} />Research</Link> : (
          <button onClick={() => openSection("overview")}><ArrowLeft size={16} />Back to research</button>
        )}
        <details ref={menu} className={styles.menu} onKeyDown={(event) => {
          if (event.key === "Escape" && menu.current) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); }
        }}>
          <summary aria-label="Research options"><MoreHorizontal size={23} /></summary>
          <div className={styles.menuItems}>
            <button onClick={() => openSection("thesis")}>Full report</button>
            <button onClick={() => openSection("metrics")}>Metrics</button>
            <button onClick={() => openSection("backtests")}>Backtests</button>
            <button onClick={() => openSection("sources")}>Sources</button>
            <button onClick={() => openSection("runs")}>Run history</button>
            <Link href={`/assets/${assetId}`}>Asset details</Link>
          </div>
        </details>
      </div>

      {activeTab === "overview" ? <>
        <div className={styles.titleRow}>
          <span className={styles.status} data-tone={action.tone}>{action.label}</span>
        </div>
        {!data.activeRun ? <div className={styles.empty}>
          <p>No research yet.</p>
          <Link className={styles.primary} href={action.href}>{action.action}</Link>
        </div> : <>
          <p className={styles.lead}>{safeText(thesis.thesis_statement ?? thesis.thesis ?? thesis.investment_thesis, "The research summary is not available yet.")}</p>
          {data.report?.incomplete && <details className={styles.missing}>
            <summary>Research incomplete<ChevronDown size={16} /></summary>
            <ul>{(data.report.missing_sections ?? []).map((item: ResearchRecord) => <li key={item.type}>{item.label}</li>)}</ul>
          </details>}
          <div key={data.activeRun.id}>
            <details className={styles.section} open>
              <summary>Thesis<ChevronDown size={20} /></summary>
              <div className={styles.sectionBody}>
                {conditions.length ? <ul>{conditions.slice(0, 2).map((condition) => <li key={condition}>{condition}</li>)}</ul> : <p>{safeText(thesis.causal_chain, "No thesis details yet.")}</p>}
                {(conditions.length > 2 || typeof thesis.causal_chain === "string") && <details className={styles.more}>
                  <summary>Read more</summary>
                  {conditions.length > 2 && <ul>{conditions.slice(2).map((condition) => <li key={condition}>{condition}</li>)}</ul>}
                  {typeof thesis.causal_chain === "string" && <p>{thesis.causal_chain}</p>}
                  {typeof thesis.market_mispricing === "string" && <p>{thesis.market_mispricing}</p>}
                </details>}
              </div>
            </details>
            <details className={styles.section}>
              <summary>Valuation<ChevronDown size={20} /></summary>
              <div className={styles.sectionBody}>
                {targetRows?.length ? <div className={styles.targetTable}><table>
                  <thead><tr><th>Year</th><th>Bear</th><th>Base</th><th>Bull</th></tr></thead>
                  <tbody>{groupPriceTargets(targetRows).map((row) => <tr key={row.year}><td>{row.year}</td><td>{formatCurrency(row.bear, targets.currency ?? data.asset?.base_currency)}</td><td>{formatCurrency(row.base, targets.currency ?? data.asset?.base_currency)}</td><td>{formatCurrency(row.bull, targets.currency ?? data.asset?.base_currency)}</td></tr>)}</tbody>
                </table></div> : <p>No annual price targets yet.</p>}
                <button className={styles.textLink} onClick={() => openSection("valuation")}>Valuation details<ArrowUpRight size={16} /></button>
              </div>
            </details>
            <details className={styles.section} open>
              <summary>Open questions<ChevronDown size={20} /></summary>
              <div className={styles.questions}>
                {risks.length ? risks.slice(0, 2).map((risk, index) => <RiskQuestion key={index} risk={risk} />) : <p>No risk register yet.</p>}
                {risks.length > 2 && <details className={styles.moreRisks}>
                  <summary>All {risks.length} risks<ChevronDown size={16} /></summary>
                  {risks.slice(2).map((risk, index) => <RiskQuestion key={index} risk={risk} />)}
                </details>}
              </div>
            </details>
          </div>
          <footer className={styles.actions}>
            <button className={styles.textLink} onClick={() => openSection("evidence")}>Evidence<ArrowUpRight size={17} /></button>
            <Link className={styles.primary} href={action.href}>{action.action}</Link>
          </footer>
        </>}
      </> : <>
        {activeTab !== "runs" && !(activeTab === "thesis" && data.report?.report_document) && <input className={styles.filter} type="search" aria-label="Search this section" placeholder="Search this section" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />}
        <div className={styles.supporting}>
          {activeTab === "evidence" && <EvidenceSection evidence={filtered.evidence} />}
          {activeTab === "metrics" && <MetricsSection metrics={filtered.metrics} />}
          {activeTab === "valuation" && <ValuationSection signals={filtered.signals} scenarios={filtered.scenarios} valuationChartData={valuationChartData} />}
          {activeTab === "thesis" && (data.report?.report_document ? <ResearchReport document={data.report.report_document} /> : <><CanonicalReportSummary report={data.report} artifacts={data.artifacts} /><ThesisSection theses={filtered.theses} risks={filtered.risks} catalysts={filtered.catalysts} /></>)}
          {activeTab === "backtests" && <BacktestsSection backtests={filtered.backtests} />}
          {activeTab === "sources" && <SourcesSection sources={filtered.sources} modelCalls={filtered.modelCalls} runDetail={data.runDetail} />}
          {activeTab === "runs" && <div className={styles.runHistory}>
            <label htmlFor="report-run">Research run</label>
            <select id="report-run" value={data.activeRun?.id ?? ""} onChange={(event) => router.push(sectionHref('runs',event.target.value))}>
              {data.runs.map((item) => <option key={item.id} value={item.id}>{formatDate(item.created_at)} · {cleanLabel(item.status)} · {shortId(item.id)}</option>)}
            </select>
            <p>{action.label}</p>
            <Link className={styles.textLink} href={`/assets/${assetId}/run?run=${data.activeRun?.id ?? ""}`}>Open run<ArrowUpRight size={16} /></Link>
            <DataTable columns={["Stage", "Status"]} rows={(data.runDetail?.stages ?? []).map((stage: ResearchRecord) => [cleanLabel(stage.stage_name ?? stage.stage_key), cleanLabel(stage.status)])} />
          </div>}
        </div>
      </>}
    </div>
  );
}

function AssetTabs({ activeTab, hrefFor }: { activeTab: TabId; hrefFor: (view: TabId) => string }) {
  const nav = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);

  // One underline for the whole nav. It glides to the active tab (transform only).
  useLayoutEffect(() => {
    const place = () => {
      const bar = indicator.current;
      if (!bar) return;
      const link = nav.current?.querySelector<HTMLElement>("a[aria-current]");
      bar.style.opacity = link ? "1" : "0";
      if (!link) return;
      bar.style.transform = `translateX(${link.offsetLeft}px) scaleX(${link.offsetWidth})`;
      // First placement must not animate from the left edge; enable the transition afterwards.
      if (bar.dataset.ready === undefined) { void bar.offsetWidth; bar.dataset.ready = ""; }
    };
    place();
    const observer = new ResizeObserver(place);
    if (nav.current) observer.observe(nav.current);
    void document.fonts?.ready.then(place);
    return () => observer.disconnect();
  }, [activeTab]);

  return <nav ref={nav} aria-label="Asset views">
    {navViews.map((view) => <Link key={view} href={hrefFor(view)} aria-current={activeTab === view ? "page" : undefined}>{tabLabel(view)}</Link>)}
    <span ref={indicator} className={styles.tabIndicator} aria-hidden="true" />
  </nav>;
}

function RiskQuestion({ risk }: { risk: JsonRecord }) {
  return <details className={styles.question}>
    <summary>{safeText(risk.risk_name, "Risk")}<ArrowRight size={18} /></summary>
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
      <details className={ui.section}><summary>Metric comparison</summary>
        <div className="mt-4 h-[420px]">
          <MetricBarChart metrics={metrics} />
        </div>
      </details>

      <section className={styles.dataSection}>
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
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
        <section className={styles.dataSection}>
          <SectionHeader icon={CircleDollarSign} title="Cheapness Scores" count={valuationChartData.length} />
          <div className="mt-4 h-[360px]">
            <ValuationScoreChart data={valuationChartData} />
          </div>
        </section>

        <section className={styles.dataSection}>
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

      <section className={styles.dataSection}>
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
    <div>
      {theses.length === 0 ? (
        <EmptyState title="No thesis records" body="This run has not stored a thesis yet." />
      ) : (
        theses.map((thesis) => (
          <details key={thesis.id} className={ui.section}><summary>Thesis notes</summary><div className={ui.sectionBody}>
            <p className="text-base leading-relaxed text-slate-700">
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
          </div></details>
        ))
      )}

      <details className={ui.section}><summary>Risks <span className={ui.muted}>{risks.length}</span></summary><div className={ui.sectionBody}>
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
      </div></details>

      <details className={ui.section}><summary>Catalysts <span className={ui.muted}>{catalysts.length}</span></summary><div className={ui.sectionBody}>
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
      </div></details>
    </div>
  );
}

function BacktestsSection({ backtests }: { backtests: ResearchRecord[] }) {
  return (
    <section className={styles.dataSection}>
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
    <div className="space-y-5">
      <section className={styles.dataSection}>
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

      <section className={styles.dataSection}>
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

      <section className={styles.dataSection}>
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
        <Bar dataKey="value" fill="#626b78" radius={[0, 4, 4, 0]} />
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
      <div className={ui.empty}>
        No rows for this section.
      </div>
    );
  }

  return (
    <div className={`${ui.table} mt-4`}>
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-transparent">
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                className="whitespace-nowrap px-4 py-3 text-sm font-normal text-slate-600"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
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
  return <div className={ui.sectionHead}><h2>{title}</h2><span className={ui.muted}>{count}</span></div>;
}

function InsightBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="py-4">
      <div className="mb-2 text-sm font-medium text-slate-700">{label}</div>
      <p className="text-[15px] leading-relaxed text-slate-600">{safeText(value)}</p>
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
    <div className="flex h-full items-center justify-center text-sm text-slate-500">
      {label}
    </div>
  );
}

function LongText({ value }: { value: unknown }) {
  return <div className={styles.longText}>{safeText(value)}</div>;
}

function JsonPreview({ value }: { value: unknown }) {
  const text = stringifyCompact(value);
  return <details className="max-w-[420px] text-sm text-slate-600"><summary>Details</summary><div className="mt-3 whitespace-normal break-words leading-relaxed">{text}</div></details>;
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
