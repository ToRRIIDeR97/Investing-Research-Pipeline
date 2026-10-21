"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import { pollTick, runProgressIsLive } from "@/lib/research/run-polling";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface RunProgress {
  runId: string;
  pipelineVersion: number;
  status: string;
  latestJob: {
    id: string;
    status: string;
    attempt_count: number;
    failure_reason: string | null;
    result_json: Record<string, unknown> | null;
  } | null;
  workerHealthy: boolean;
  sourceRoleCount: number;
  budgetLimit: number | null;
  currentStage: string | null;
  stages: {
    id: string;
    key: string;
    order: number;
    status: string;
    started_at?: string | null;
    completed_at?: string | null;
    failure_reason?: string | null;
    validation_result_json?: Record<string, unknown> | null;
  }[];
  tasks: {
    id: string;
    stage_id: string;
    agent_name: string | null;
    task_key: string;
    task_type: string;
    status: string;
    priority: number;
    retry_count: number;
    failure_reason: string | null;
    started_at: string | null;
    completed_at: string | null;
  }[];
  sourceCount: number;
  exportCount: number;
  totalCost: number;
  createdAt?: string;
  marketDataCutoffAt?: string | null;
  requestReset: { stages: string[]; request_ids: string[]; estimated_cost_usd: number } | null;
}

interface SourceDocument {
  id: string;
  title: string;
  source_type: string;
  publisher: string | null;
  url: string | null;
  created_at: string;
}

interface AgentTrace {
  id: string;
  task_id: string | null;
  agent_name: string;
  tool_name: string | null;
  status: string;
  created_at: string;
}

interface ModelCall {
  id: string;
  agent_name: string | null;
  model_provider: string;
  model_name: string;
  model_tier: string;
  status: string;
  cost_usd: string | null;
  latency_ms: number | null;
  created_at: string;
  error_message: string | null;
}

interface BacktestRun {
  id: string;
  status: string;
  strategy_name: string | null;
  strategy_prompt: string;
  symbol: string;
  benchmark_symbol: string | null;
  error_message: string | null;
  created_at: string;
}

interface ResearchQuality {
  status: "pass" | "needs_more_work" | "fail";
  actionReadiness: "triage_only" | "research_scaffold" | "review_ready" | "investment_ready";
  errors: string[];
  warnings: string[];
  missingCoverage: {
    key: string;
    severity: "low" | "medium" | "high" | "critical";
    area: string;
    description: string;
    requiredForCompletion: boolean;
  }[];
  counts: {
    sources: number;
    evidence: number;
    metrics: number;
    valuationSignals: number;
    scenarios: number;
    scenariosWithValueAnchors: number;
    openSourceGaps: number;
    reviewDecisions: number;
  };
}

interface TheaterData {
  sources: SourceDocument[];
  traces: AgentTrace[];
  modelCalls: ModelCall[];
  backtests: BacktestRun[];
}

interface TimelineEvent {
  id: string;
  time: string;
  type: "stage" | "task" | "source" | "trace" | "model" | "backtest" | "message";
  title: string;
  detail: string;
  status: string;
}

function humanize(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "unknown";
}

function formatMoney(value: string | number | null | undefined) {
  const numeric = Number(value || 0);
  return `$${numeric.toFixed(4)}`;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildTimeline(
  progress: RunProgress | null,
  theater: TheaterData,
  messages: Message[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const stage of progress?.stages || []) {
    events.push({
      id: `stage-${stage.id}`,
      time: stage.completed_at || stage.started_at || progress?.createdAt || new Date().toISOString(),
      type: "stage",
      title: humanize(stage.key),
      detail: stage.failure_reason || `Stage is ${stage.status}`,
      status: stage.status,
    });
  }

  for (const task of progress?.tasks || []) {
    events.push({
      id: `task-${task.id}`,
      time: task.completed_at || task.started_at || progress?.createdAt || new Date().toISOString(),
      type: "task",
      title: task.agent_name || humanize(task.task_type),
      detail: task.failure_reason || humanize(task.task_key),
      status: task.status,
    });
  }

  for (const source of theater.sources) {
    events.push({
      id: `source-${source.id}`,
      time: source.created_at,
      type: "source",
      title: source.title,
      detail: humanize(source.source_type),
      status: "completed",
    });
  }

  for (const trace of theater.traces) {
    events.push({
      id: `trace-${trace.id}`,
      time: trace.created_at,
      type: "trace",
      title: trace.agent_name,
      detail: trace.tool_name || "agent trace",
      status: trace.status,
    });
  }

  for (const call of theater.modelCalls) {
    events.push({
      id: `model-${call.id}`,
      time: call.created_at,
      type: "model",
      title: call.agent_name || call.model_tier,
      detail: `${call.model_provider}/${call.model_name}`,
      status: call.status,
    });
  }

  for (const backtest of theater.backtests) {
    events.push({
      id: `backtest-${backtest.id}`,
      time: backtest.created_at,
      type: "backtest",
      title: backtest.strategy_name || `${backtest.symbol} backtest`,
      detail: backtest.error_message || backtest.strategy_prompt,
      status: backtest.status,
    });
  }

  messages.forEach((message, index) => {
    if (message.role !== "system") return;
    events.push({
      id: `message-${index}`,
      time: new Date().toISOString(),
      type: "message",
      title: "operator note",
      detail: message.content,
      status: "completed",
    });
  });

  return events
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 36);
}

function StatusBadge({ status }: { status: string }) {
  return <span className={ui.status} data-status={status}>{humanize(status).replace(/^./, (letter) => letter.toUpperCase())}</span>;
}

function ResearchPlanCard({ plan }: { plan: Record<string, any> | null }) {
  if (!plan) return <p className={ui.notice}>Preparing the research plan…</p>;
  const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
  return <>
    <p className={ui.lead}>{plan.research_question || "No research question recorded."}</p>
    <dl className={ui.metadata}>
      <div><dt>Budget</dt><dd>{plan.budget?.limit_usd != null ? `$${plan.budget.limit_usd}` : "Not set"}</dd></div>
      <div><dt>Profile</dt><dd>{[...list(plan.composed_archetypes), ...list(plan.overlays)].map(humanize).join(" · ") || "Not set"}</dd></div>
    </dl>
    {[
      ["Valuation methods", list(plan.valuation_methods).map((item) => `${humanize(item.method || item.method_key)}: ${item.allowed === false ? "excluded" : "included"}`)],
      ["Source requirements", list(plan.required_source_roles).map((item) => `${humanize(item.role)}: ${item.required === false ? "optional" : "required"}`)],
      ["Analysis modules", list(plan.required_analysis_modules).map((item) => `${humanize(item.artifact_type)}: ${item.required === false ? "optional" : "required"}`)],
      ["Planned stages", list(plan.applicable_stages).map((item) => `${item.order}. ${item.name || humanize(item.key)}`)],
    ].map(([title, values]) => <details key={String(title)} className={ui.section}><summary>{title}</summary><div className={ui.sectionBody}><ul>{(values as string[]).map((value, index) => <li key={index}>{value}</li>)}</ul></div></details>)}
    <p className={`${ui.muted} mt-6`}>Source cutoff: {plan.cutoffs?.source_cutoff_at ? new Date(plan.cutoffs.source_cutoff_at).toLocaleString() : "Not set"}<br />Market cutoff: {plan.cutoffs?.market_data_cutoff_at ? new Date(plan.cutoffs.market_data_cutoff_at).toLocaleString() : "Not set"}</p>
  </>;
}

function RunDetails({ progress, theater, quality, messages }: { progress: RunProgress; theater: TheaterData; quality: ResearchQuality | null; messages: Message[] }) {
  const completed = progress.stages.filter((stage) => stage.status === "completed").length;
  const current = progress.stages.find((stage) => ["running", "waiting_for_human", "failed"].includes(stage.status));
  const blockers = quality?.missingCoverage.filter((item) => item.requiredForCompletion) || [];
  const events = buildTimeline(progress, theater, messages);
  return <>
    <div className="flex items-center justify-between gap-4 text-sm text-[#626b78]"><span>{completed} of {progress.stages.length} stages complete</span><span>{formatMoney(progress.totalCost)}</span></div>
    <progress className={ui.progress} max={progress.stages.length || 1} value={completed} aria-label="Research progress" />
    {current && <p className={ui.muted}>{humanize(current.key)} · {humanize(current.status)}</p>}
    {progress.latestJob?.failure_reason && <p className={ui.error} role="alert">{progress.latestJob.failure_reason}</p>}
    {!progress.workerHealthy && progress.latestJob?.status === "queued" && <p className={ui.notice}>Waiting for an available worker.</p>}
    <details className={ui.section}><summary>Stages</summary><div className={ui.sectionBody}>
      {progress.stages.map((stage) => <div key={stage.id} className={ui.row}><div><div className={ui.rowTitle}>{humanize(stage.key)}</div>{stage.failure_reason && <p className={ui.error}>{stage.failure_reason}</p>}<div className={ui.rowMeta}>{formatTime(stage.completed_at || stage.started_at)}</div></div><StatusBadge status={stage.status} /></div>)}
    </div></details>
    <details className={ui.section} open={quality?.status === "fail"}><summary>Quality checks {quality && <StatusBadge status={quality.status} />}</summary><div className={ui.sectionBody}>
      {quality ? <>
        <dl className={ui.metadata}>{[["Evidence", quality.counts.evidence], ["Sources", quality.counts.sources], ["Valuation anchors", quality.counts.scenariosWithValueAnchors], ["Open gaps", quality.counts.openSourceGaps]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p className="mt-6">{humanize(quality.actionReadiness)}</p>
        {blockers.length > 0 && <ul className="mt-4">{blockers.map((item, index) => <li key={index}>{item.description}</li>)}</ul>}
        {quality.errors.filter((error) => !blockers.some((item) => item.description === error)).map((error, index) => <p key={index} className={ui.error}>{error}</p>)}
        {quality.warnings.length > 0 && <details className="mt-4"><summary>Warnings ({quality.warnings.length})</summary><ul className="mt-3">{quality.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      </> : <p>Quality checks are not available yet.</p>}
    </div></details>
    <details className={ui.section}><summary>Activity</summary><div className={ui.sectionBody}>
      {events.length ? events.map((event) => <div key={event.id} className={ui.row}><div><div className={ui.rowTitle}>{event.title}</div><p className={ui.rowMeta}>{event.detail}</p><span className={ui.rowMeta}>{formatTime(event.time)}</span></div><StatusBadge status={event.status} /></div>) : <p>No activity yet.</p>}
      <details className="mt-6"><summary>Tasks ({progress.tasks.length})</summary>{progress.tasks.map((task) => <div key={task.id} className={ui.row}><div><div>{task.agent_name || humanize(task.task_type)}</div><p className={ui.rowMeta}>{task.failure_reason || humanize(task.task_key)}</p></div><StatusBadge status={task.status} /></div>)}</details>
      <details className="mt-6"><summary>Model calls ({theater.modelCalls.length})</summary>{theater.modelCalls.map((call) => <div key={call.id} className={ui.row}><div><div>{call.agent_name || call.model_tier}</div><p className={ui.rowMeta}>{call.model_provider}/{call.model_name} · {formatMoney(call.cost_usd)}</p>{call.error_message && <p className={ui.error}>{call.error_message}</p>}</div><StatusBadge status={call.status} /></div>)}</details>
    </div></details>
    <details className={ui.section}><summary>Run details</summary><dl className={`${ui.metadata} ${ui.sectionBody}`}>
      <div><dt>Run</dt><dd>{progress.runId}</dd></div><div><dt>Created</dt><dd>{progress.createdAt ? new Date(progress.createdAt).toLocaleString() : "Not set"}</dd></div>
      <div><dt>Job</dt><dd>{humanize(progress.latestJob?.status)}</dd></div><div><dt>Market data cutoff</dt><dd>{progress.marketDataCutoffAt ? new Date(progress.marketDataCutoffAt).toLocaleString() : "Not set"}</dd></div>
      <div><dt>Budget</dt><dd>{progress.budgetLimit != null ? `$${progress.budgetLimit}` : "Not set"}</dd></div><div><dt>Exports</dt><dd>{progress.exportCount}</dd></div>
    </dl></details>
  </>;
}

export default function RunResearchPage() {
  const params = useParams();
  const assetId = params.id as string;

  const [phase, setPhase] = useState<"intake" | "plan" | "pipeline">("intake");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [assetName, setAssetName] = useState("");
  const [researchPlan, setResearchPlan] = useState<Record<string, any> | null>(null);
  const [planChangeNotes, setPlanChangeNotes] = useState("");
  const [sourceCutoffAt, setSourceCutoffAt] = useState("");
  const [marketDataCutoffAt, setMarketDataCutoffAt] = useState("");
  const [budgetLimitUsd, setBudgetLimitUsd] = useState("");
  const [runType, setRunType] = useState("deep_dive");
  const [runId, setRunId] = useState<string | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const progressRequest = useRef(0);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [quality, setQuality] = useState<ResearchQuality | null>(null);
  const [theater, setTheater] = useState<TheaterData>({
    sources: [],
    traces: [],
    modelCalls: [],
    backtests: [],
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isBacktestSubmitting, setIsBacktestSubmitting] = useState(false);
  const [backtestPrompt, setBacktestPrompt] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    async function loadAssetContext() {
      try {
        const [assetRes, runsRes] = await Promise.all([
          fetch(`/api/assets/${assetId}`),
          fetch(`/api/assets/${assetId}/research-runs`),
        ]);
        if (!assetRes.ok || !runsRes.ok) throw new Error("Unable to load research.");
        if (assetRes.ok) {
          const data = await assetRes.json();
          setAssetName(data.canonical_name);
        }
        if (runsRes.ok) {
          const runs = await runsRes.json();
          const requestedRunId = new URLSearchParams(window.location.search).get("run");
          const latestRun = !new URLSearchParams(window.location.search).has("new") && Array.isArray(runs)
            ? requestedRunId
              ? runs.find((run) => run.id === requestedRunId)
              : [...runs]
                .sort(
                  (a, b) =>
                    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                )[0]
            : null;
          if (requestedRunId && !latestRun) throw new Error("Research run not found.");
          if (latestRun) {
            activeRunRef.current = latestRun.id;
            setRunId(latestRun.id);
            setPhase("pipeline");
            setMessages((prev) =>
              prev.length === 0
                ? [
                    {
                      role: "system",
                      content: `Loaded research run: ${latestRun.id}`,
                    },
                  ]
                : prev
            );
            await fetchProgress(latestRun.id);
          }
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Unable to load research.");
      } finally {
        setLoading(false);
      }
    }
    loadAssetContext();
  }, [assetId]);

  // Poll only while the run or its job is active, one request at a time and not while the tab is hidden.
  // Approving the plan, a re-run decision and a run start all refresh progress, which re-arms polling for the queued job.
  const runLive = runProgressIsLive(progress?.status, progress?.latestJob?.status);
  useEffect(() => {
    if (!runId || phase !== "pipeline" || !runLive) return;
    const interval = window.setInterval(pollTick(() => fetchProgress(runId), () => document.visibilityState !== "visible"), 5000);
    return () => window.clearInterval(interval);
  }, [runId, phase, runLive]);

  async function handleSend() {
    if (phase !== "intake" || !input.trim() || isProcessing) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsProcessing(true);

    if (phase === "intake") await createAndStartRun(userMessage);

    setIsProcessing(false);
  }

  async function createAndStartRun(userMessage: string) {
    setIsProcessing(true);
    setMessages((prev) => [
      ...prev,
      { role: "system", content: "Creating v3 run and queueing the durable worker job..." },
    ]);

    try {
      // Create the research run
      const res = await fetch(`/api/assets/${assetId}/research-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_type: runType,
          research_question: userMessage,
          requested_by: "user",
          ...(sourceCutoffAt ? { source_cutoff_at: new Date(sourceCutoffAt).toISOString() } : {}),
          ...(marketDataCutoffAt ? { market_data_cutoff_at: new Date(marketDataCutoffAt).toISOString() } : {}),
          ...(budgetLimitUsd ? { budget_limit_usd: Number(budgetLimitUsd) } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Unable to create run");
      const run = await res.json();
      activeRunRef.current = run.id;
      setRunId(run.id);
      window.history.replaceState(null, "", `/assets/${assetId}/run?run=${run.id}`);
      setPhase("pipeline");

      const startRes = await fetch(`/api/research-runs/${run.id}/run-system-pipeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requested_by: "user" }),
      });
      if (!startRes.ok) throw new Error((await startRes.json()).error || "Unable to queue run");
      const queued = await startRes.json();

      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `Research run created: ${run.id}\nPipeline version: ${run.pipeline_version}\nJob queued: ${queued.jobId}`,
        },
      ]);

      // Fetch initial progress
      fetchProgress(run.id);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Error creating run: ${error}` },
      ]);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleApprovePlan() {
    if (!runId) return;
    setIsProcessing(true);
    try {
      const res = await fetch(`/api/research-runs/${runId}/approve-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved_by: "user" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Unable to approve plan");
      setPhase("pipeline");
      setMessages((prev) => [...prev, { role: "system", content: `Plan approved. Resume job queued: ${body.jobId}` }]);
      fetchProgress(runId);
    } catch (error) {
      setMessages((prev) => [...prev, { role: "system", content: `Plan approval error: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRequestPlanChanges() {
    if (!runId || !planChangeNotes.trim()) return;
    setIsProcessing(true);
    try {
      const res = await fetch(`/api/research-runs/${runId}/request-plan-changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: planChangeNotes.trim(), requested_by: "user" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Unable to save plan changes");
      setMessages((prev) => [...prev, { role: "system", content: "Plan-change notes saved. The run remains at the research-plan gate." }]);
      setPlanChangeNotes("");
      fetchProgress(runId);
    } catch (error) {
      setMessages((prev) => [...prev, { role: "system", content: `Plan-change error: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRequestReset(decision: "rerun" | "skip") {
    if (!runId) return;
    setIsProcessing(true);
    try {
      const res = await fetch(`/api/research-runs/${runId}/request-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, actor: "user" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Unable to record the decision");
      setMessages((prev) => [...prev, { role: "system", content: `${decision === "rerun" ? "Re-run approved" : "Re-run skipped"}. Resume job queued: ${body.jobId}` }]);
      fetchProgress(runId);
    } catch (error) {
      setMessages((prev) => [...prev, { role: "system", content: `Re-run decision error: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleCancelRun() {
    if (!runId || !window.confirm("Cancel this run? A cancelled run stops its current model call and cannot be resumed.")) return;
    setIsProcessing(true);
    try {
      const res = await fetch(`/api/research-runs/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "user" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Unable to cancel the run");
      setMessages((prev) => [...prev, { role: "system", content: "Run cancelled. A model call in progress stops within a few seconds." }]);
      fetchProgress(runId);
    } catch (error) {
      setMessages((prev) => [...prev, { role: "system", content: `Cancel error: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setIsProcessing(false);
    }
  }

  async function fetchProgress(id: string) {
    // A slower, older response must not overwrite a newer one (for example a poll that started before an approval).
    const request = ++progressRequest.current;
    const current = () => activeRunRef.current === id && progressRequest.current === request;
    try {
      const [runRes, qualityRes, sourcesRes, tracesRes, modelCallsRes, backtestsRes, jobsRes] =
        await Promise.all([
          fetch(`/api/research-runs/${id}`),
          fetch(`/api/research-runs/${id}/quality`),
          fetch(`/api/research-runs/${id}/sources`),
          fetch(`/api/research-runs/${id}/agent-traces`),
          fetch(`/api/research-runs/${id}/model-calls`),
          fetch(`/api/research-runs/${id}/backtests`),
          fetch(`/api/research-runs/${id}/jobs`),
        ]);

      if (!runRes.ok) throw new Error("Unable to refresh this run.");
      const data = await runRes.json();
      const qualityData = qualityRes.ok ? await qualityRes.json() : null;
      const sources = sourcesRes.ok ? await sourcesRes.json() : [];
      const traces = tracesRes.ok ? await tracesRes.json() : [];
      const modelCalls = modelCallsRes.ok ? await modelCallsRes.json() : [];
      const backtests = backtestsRes.ok ? await backtestsRes.json() : [];
      const jobsData = jobsRes.ok ? await jobsRes.json() : { latestJob: null, workers: [] };
      const planWaiting = data.stages?.some((stage: any) => stage.stage_key === "research_plan" && stage.status === "waiting_for_human");
      // The page shows only the research plan, and only while it waits for approval.
      const planRes = planWaiting ? await fetch(`/api/research-runs/${id}/artifacts?type=research_plan`) : null;
      const artifactsData = planRes?.ok ? await planRes.json() : { artifacts: [] };
      if (!current()) return;
      const planArtifact = (artifactsData.artifacts || []).find((artifact: any) => artifact.type === "research_plan");
      if (planArtifact) setResearchPlan(planArtifact.content_json || null);
      if (planWaiting) setPhase("plan");
      else if (phase === "plan") setPhase("pipeline");

      setProgress({
        runId: data.id,
        pipelineVersion: Number(data.pipeline_version || 0),
        status: data.status,
        latestJob: jobsData.latestJob || data.latest_job || null,
        workerHealthy: Boolean(data.worker_health?.healthy || (jobsData.workers || []).some((worker: any) => worker.status === "healthy" && !worker.stale)),
        sourceRoleCount: Number(data.source_role_count || new Set((data.source_role_coverage || []).map((row: any) => row.source_role)).size),
        budgetLimit: data.budget_limit_usd ? Number(data.budget_limit_usd) : null,
        currentStage: data.stages?.find((s: any) => s.status === "running")?.stage_key || null,
        stages: data.stages?.map((s: any) => ({
          id: s.id,
          key: s.stage_key,
          order: s.stage_order,
          status: s.status,
          started_at: s.started_at,
          completed_at: s.completed_at,
          failure_reason: s.failure_reason,
          validation_result_json: s.validation_result_json,
        })) || [],
        tasks: (data.tasks || []).map((t: any) => ({
          id: t.id,
          stage_id: t.stage_id,
          agent_name: t.agent_name,
          task_key: t.task_key,
          task_type: t.task_type,
          status: t.status,
          priority: t.priority,
          retry_count: t.retry_count,
          failure_reason: t.failure_reason,
          started_at: t.started_at,
          completed_at: t.completed_at,
        })),
        sourceCount: Array.isArray(sources) ? sources.length : 0,
        exportCount: data.metadata_json?.export_count || 0,
        totalCost: parseFloat(data.actual_cost_usd || "0"),
        createdAt: data.created_at,
        marketDataCutoffAt: data.market_data_cutoff_at,
        requestReset: data.metadata_json?.request_reset || null,
      });

      setTheater({
        sources: Array.isArray(sources) ? sources : [],
        traces: Array.isArray(traces) ? traces : [],
        modelCalls: Array.isArray(modelCalls) ? modelCalls : [],
        backtests: Array.isArray(backtests) ? backtests : [],
      });
      setQuality(qualityData);
      setLoadError("");
    } catch (error) {
      if (current()) setLoadError("Unable to refresh this run. Displayed progress may be out of date.");
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !runId) return;

    setIsUploading(true);
    setMessages((prev) => [
      ...prev,
      { role: "system", content: `Uploading file: ${file.name}...` },
    ]);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("source_type", "upload");
      formData.append("title", file.name);

      const res = await fetch(`/api/research-runs/${runId}/sources/ingest`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || "Upload failed");
      }

      const doc = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `File uploaded successfully: ${doc.title || file.name} (${doc.id})`,
        },
      ]);
      // Refresh progress to pick up updated source count
      fetchProgress(runId);
    } catch (error: any) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Upload error: ${error.message}` },
      ]);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleLinkAttach() {
    if (!linkUrl.trim() || !runId) return;

    setIsUploading(true);
    setMessages((prev) => [
      ...prev,
      { role: "system", content: `Ingesting URL: ${linkUrl}...` },
    ]);

    try {
      const formData = new FormData();
      formData.append("source_type", "url");
      formData.append("url", linkUrl);
      formData.append("title", linkUrl);

      const res = await fetch(`/api/research-runs/${runId}/sources/ingest`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || "Ingest failed");
      }

      const doc = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `URL source ingested: ${doc.title || linkUrl} (${doc.id})`,
        },
      ]);
      setLinkUrl("");
      setShowLinkInput(false);
      fetchProgress(runId);
    } catch (error: any) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `URL ingest error: ${error.message}` },
      ]);
    } finally {
      setIsUploading(false);
    }
  }

  async function handleBacktestRequest() {
    if (!runId || !backtestPrompt.trim()) return;

    setIsBacktestSubmitting(true);
    try {
      const res = await fetch(`/api/research-runs/${runId}/backtests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy_prompt: backtestPrompt.trim(),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Backtest request failed");
      }

      const backtest = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `Backtest queued: ${backtest.symbol} (${backtest.id})`,
        },
      ]);
      setBacktestPrompt("");
      fetchProgress(runId);
    } catch (error: any) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Backtest error: ${error.message}` },
      ]);
    } finally {
      setIsBacktestSubmitting(false);
    }
  }

  if (loading) return <div className={ui.page} role="status">Loading research…</div>;
  const finalReviewWaiting = progress?.stages.some((stage) => stage.key === "human_review" && stage.status === "waiting_for_human");
  const lastMessage = messages[messages.length - 1];

  return <div className={`${ui.page} ${ui.withBack}`}>
    <Link href={`/assets/${assetId}/view${runId ? `?run=${runId}` : ""}`} className={ui.back}><ArrowLeft size={17} />Research brief</Link>
    <header className={ui.heading}><h1>{assetName || "Research"}</h1>{phase !== "intake" && progress && <StatusBadge status={progress.status} />}</header>
    {loadError && <p className={ui.error} role="alert">{loadError}{runId && <button onClick={() => fetchProgress(runId)}>Try again</button>}</p>}
    {phase === "intake" && !loadError ? <form className={ui.form} onSubmit={(event) => { event.preventDefault(); handleSend(); }}>
      <label className={ui.field}>Research question<textarea rows={4} value={input} onChange={(event) => setInput(event.target.value)} placeholder={`What would you like to understand about ${assetName}?`} disabled={isProcessing} required /></label>
      <div className="flex flex-wrap gap-x-6 gap-y-2">{["Long-term investment thesis", "Update valuation"].map((label, index) => <button key={label} type="button" className={ui.textLink} onClick={() => setInput(index === 0 ? `Research ${assetName} as a long-term compounder` : "Update valuation with latest data")}>{label}</button>)}</div>
      <label className={ui.field}>Research type<select value={runType} onChange={(event) => setRunType(event.target.value)} disabled={isProcessing}>{[["quick_scan", "Quick scan"], ["deep_dive", "Deep dive"], ["thesis_investigation", "Thesis investigation"], ["full_initiation_report", "Full initiation report"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <details className={ui.section}><summary>Budget and data cutoffs</summary><div className={`${ui.form} ${ui.sectionBody}`}>
        <label className={ui.field}>Budget (USD)<input type="number" min="0" step="0.01" value={budgetLimitUsd} onChange={(event) => setBudgetLimitUsd(event.target.value)} disabled={isProcessing} /></label>
        <div className={ui.formGrid}><label className={ui.field}>Source cutoff<input type="datetime-local" value={sourceCutoffAt} onChange={(event) => setSourceCutoffAt(event.target.value)} disabled={isProcessing} /></label><label className={ui.field}>Market data cutoff<input type="datetime-local" value={marketDataCutoffAt} onChange={(event) => setMarketDataCutoffAt(event.target.value)} disabled={isProcessing} /></label></div>
      </div></details>
      <div className={ui.actions}><span /><button className={ui.primary} disabled={isProcessing || !input.trim()}>{isProcessing ? "Creating…" : "Create research plan"}</button></div>
    </form> : phase === "plan" ? <>
      <h2 className="mb-8 text-[22px]">Review research plan</h2>
      <ResearchPlanCard plan={researchPlan} />
      <div className={`${ui.form} mt-8`}><label className={ui.field}>Requested changes<textarea rows={3} value={planChangeNotes} onChange={(event) => setPlanChangeNotes(event.target.value)} disabled={isProcessing} /></label><div className={ui.actions}>
        <button className={ui.secondary} onClick={handleRequestPlanChanges} disabled={isProcessing || !planChangeNotes.trim()}>Request changes</button>
        <button className={ui.primary} onClick={handleApprovePlan} disabled={isProcessing}>{isProcessing ? "Saving…" : "Approve plan & start"}</button>
      </div></div>
    </> : progress ? <>
      {finalReviewWaiting && <div className={`${ui.actions} mb-8 mt-0 border-t-0 pt-0`}><p className={ui.muted}>Ready for your review.</p><Link className={ui.primary} href={`/review?run=${runId}`}>Review research</Link></div>}
      {progress.requestReset && <section className="mb-8" aria-label="Re-run approval">
        <h2 className="mb-3 text-[22px]">Approve a re-run?</h2>
        <p className={ui.muted}>A specialist asked to recompute its analysis to answer {progress.requestReset.request_ids.length === 1 ? "one report question" : `${progress.requestReset.request_ids.length} report questions`}. Re-running reopens {progress.requestReset.stages.length} stages; their earlier model calls cost {formatMoney(progress.requestReset.estimated_cost_usd)}. Skipping keeps the current analysis and lists the requests as open questions.</p>
        <ul className="mt-4">{progress.requestReset.stages.map((stage) => <li key={stage}>{humanize(stage)}</li>)}</ul>
        <div className={ui.actions}>
          <button className={ui.secondary} onClick={() => handleRequestReset("skip")} disabled={isProcessing}>Skip re-run</button>
          <button className={ui.primary} onClick={() => handleRequestReset("rerun")} disabled={isProcessing}>{isProcessing ? "Saving…" : "Re-run stages"}</button>
        </div>
      </section>}
      <RunDetails progress={progress} theater={theater} quality={quality} messages={messages} />
    </> : null}
    {runId && progress && <>
      <details className={ui.section}><summary>Sources <span className={ui.muted}>{theater.sources.length}</span></summary><div className={ui.sectionBody}>
        {theater.sources.length ? theater.sources.map((source) => <div key={source.id} className={ui.row}><div><div className={ui.rowTitle}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{source.title}</a> : source.title}</div><p className={ui.rowMeta}>{[humanize(source.source_type), source.publisher].filter(Boolean).join(" · ")}</p></div></div>) : <p>No sources attached.</p>}
        <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" aria-label="Upload source file" />
        <div className={ui.actions}><button className={ui.secondary} onClick={() => fileInputRef.current?.click()} disabled={isUploading}>{isUploading ? "Attaching…" : "Attach file"}</button><button className={ui.textLink} onClick={() => setShowLinkInput(!showLinkInput)} disabled={isUploading}>Attach link</button></div>
        {showLinkInput && <form className="mt-6" onSubmit={(event) => { event.preventDefault(); handleLinkAttach(); }}><label className={ui.field}>Source URL<input type="url" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} required disabled={isUploading} /></label><div className={ui.actions}><button type="button" className={ui.textLink} onClick={() => { setShowLinkInput(false); setLinkUrl(""); }}>Cancel</button><button className={ui.primary} disabled={isUploading || !linkUrl.trim()}>Attach source</button></div></form>}
      </div></details>
      <details className={ui.section}><summary>Backtests <span className={ui.muted}>{theater.backtests.length}</span></summary><div className={ui.sectionBody}>
        {theater.backtests.map((test) => <div key={test.id} className={ui.row}><div><div className={ui.rowTitle}>{test.strategy_name || `${test.symbol} backtest`}</div><p className={ui.rowMeta}>{test.error_message || test.strategy_prompt}</p></div><StatusBadge status={test.status} /></div>)}
        <form className="mt-6" onSubmit={(event) => { event.preventDefault(); handleBacktestRequest(); }}><label className={ui.field}>Strategy<textarea rows={3} value={backtestPrompt} onChange={(event) => setBacktestPrompt(event.target.value)} disabled={isBacktestSubmitting} placeholder="Describe the strategy to test" required /></label><div className={ui.actions}><span /><button className={ui.primary} disabled={isBacktestSubmitting || !backtestPrompt.trim()}>{isBacktestSubmitting ? "Queueing…" : "Queue backtest"}</button></div></form>
      </div></details>
      {phase === "pipeline" && <footer className={ui.actions}><Link href={`/assets/${assetId}/view?run=${runId}`} className={ui.textLink}>Read research<ArrowUpRight size={16} /></Link><span className="flex flex-wrap items-center gap-6">{!["completed", "cancelled"].includes(progress.status) && <button className={ui.textLink} onClick={handleCancelRun} disabled={isProcessing}>Cancel run</button>}<button className={ui.secondary} onClick={() => { activeRunRef.current = null; window.history.replaceState(null, "", `/assets/${assetId}/run?new=1`); setRunId(null); setProgress(null); setQuality(null); setResearchPlan(null); setPhase("intake"); setMessages([]); setTheater({ sources: [], traces: [], modelCalls: [], backtests: [] }); setLoadError(""); }}>New research</button></span></footer>}
    </>}
    {lastMessage && !lastMessage.content.startsWith("Loaded research run") && <p className={`${ui.notes} ${ui.notice}`} role="status">{lastMessage.content}</p>}
  </div>;
}
