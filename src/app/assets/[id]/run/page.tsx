"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import { AssetHero } from "@/components/company/company";
import styles from "./page.module.css";
import { STAGE_CONFIG_MAP } from "@/lib/workflow/stages";
import { FramingEditor, type FramingEdits } from "@/components/framing-editor";
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
      title: stageLabel(stage.key),
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

/** Readable stage name, e.g. "Asset identity". */
function stageLabel(key: string) {
  const name = STAGE_CONFIG_MAP[key]?.name ?? humanize(key);
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function StatusBadge({ status }: { status: string }) {
  return <span className={ui.status} data-status={status}>{humanize(status).replace(/^./, (letter) => letter.toUpperCase())}</span>;
}

/** Forecast horizon set at the plan gate (3-10 years); sent with the approval. */
function ForecastYearsField({ value, onChange, disabled }: { value: number; onChange: (years: number) => void; disabled: boolean }) {
  return <label className={ui.field}>Forecast years<input type="number" min={3} max={10} step={1} value={value} disabled={disabled}
    onChange={(event) => onChange(Math.max(3, Math.min(10, Math.round(Number(event.target.value) || 5))))} /></label>;
}

function ResearchPlanCard({ plan }: { plan: Record<string, any> | null }) {
  if (!plan) return <p className={ui.notice}>Preparing the research plan…</p>;
  const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
  return <>
    <div className={ui.tileBody}><p className={ui.lead}>{plan.research_question || "No research question recorded."}</p></div>
    <dl className={`${ui.metadata} px-3.5`}>
      <div><dt>Budget</dt><dd>{plan.budget?.limit_usd != null ? `$${plan.budget.limit_usd}` : "Not set"}</dd></div>
      <div><dt>Forecast years</dt><dd>{plan.forecast_years ?? "Not set"}</dd></div>
      <div><dt>Profile</dt><dd>{[...list(plan.composed_archetypes), ...list(plan.overlays)].map(humanize).join(" · ") || "Not set"}</dd></div>
      <div><dt>Source cutoff</dt><dd>{plan.cutoffs?.source_cutoff_at ? new Date(plan.cutoffs.source_cutoff_at).toLocaleString() : "Not set"}</dd></div>
      <div><dt>Market cutoff</dt><dd>{plan.cutoffs?.market_data_cutoff_at ? new Date(plan.cutoffs.market_data_cutoff_at).toLocaleString() : "Not set"}</dd></div>
    </dl>
    <div className="mt-3">
    {[
      ["Valuation methods", list(plan.valuation_methods).map((item) => `${humanize(item.method || item.method_key)}: ${item.allowed === false ? "excluded" : "included"}`)],
      ["Source requirements", list(plan.required_source_roles).map((item) => `${humanize(item.role)}: ${item.required === false ? "optional" : "required"}`)],
      ["Analysis modules", list(plan.required_analysis_modules).map((item) => `${humanize(item.artifact_type)}: ${item.required === false ? "optional" : "required"}`)],
      ["Planned stages", list(plan.applicable_stages).map((item) => `${item.order}. ${item.name || humanize(item.key)}`)],
    ].map(([title, values]) => <details key={String(title)} className={styles.fold}><summary>{title}<span className={ui.muted}>{(values as string[]).length}</span></summary><ul>{(values as string[]).map((value, index) => <li key={index}>{value}</li>)}</ul></details>)}
    </div>
  </>;
}

function RunDetails({ progress, theater, quality, messages }: { progress: RunProgress; theater: TheaterData; quality: ResearchQuality | null; messages: Message[] }) {
  const completed = progress.stages.filter((stage) => stage.status === "completed").length;
  const running = progress.stages.filter((stage) => ["running", "waiting_for_human", "failed"].includes(stage.status));
  const blockers = quality?.missingCoverage.filter((item) => item.requiredForCompletion) || [];
  const events = buildTimeline(progress, theater, messages);
  return <>
    <section className={`${ui.tile} ${ui.s8}`}>
      <div className={ui.tileHead}><h2>Pipeline</h2><span className={ui.muted}>{completed} of {progress.stages.length} stages complete</span></div>
      <div className="px-3.5 pt-2">
        <progress className={ui.progress} max={progress.stages.length || 1} value={completed} aria-label="Research progress" />
        {running.length > 0 && <p className={ui.muted}>Now: {running.map((stage) => `${stageLabel(stage.key)} (${humanize(stage.status)})`).join(" · ")}</p>}
        {progress.latestJob?.failure_reason && <p className={ui.error} role="alert">{progress.latestJob.failure_reason}</p>}
        {!progress.workerHealthy && progress.latestJob?.status === "queued" && <p className={ui.notice}>Waiting for an available worker.</p>}
      </div>
      <ol className={styles.stages}>
        {progress.stages.map((stage) => <li key={stage.id} data-status={stage.status} data-gate={stage.key === "research_plan" || stage.key === "human_review" ? "" : undefined} title={stage.failure_reason || undefined}>
          <span className={styles.stageName}>{stageLabel(stage.key)}{(stage.key === "research_plan" || stage.key === "human_review") && <span className={ui.muted}> · gate</span>}</span>
          <StatusBadge status={stage.status} />
        </li>)}
      </ol>
    </section>
    <section className={`${ui.tile} ${ui.s4}`}>
      <div className={ui.tileHead}><h2>Run details</h2></div>
      <dl className={ui.kv}>
        <dt>Run</dt><dd className={ui.mono}>{progress.runId.slice(0, 8)}</dd>
        <dt>Created</dt><dd>{progress.createdAt ? new Date(progress.createdAt).toLocaleString() : "Not set"}</dd>
        <dt>Job</dt><dd>{humanize(progress.latestJob?.status)}</dd>
        <dt>Market data cutoff</dt><dd>{progress.marketDataCutoffAt ? new Date(progress.marketDataCutoffAt).toLocaleDateString() : "Not set"}</dd>
        <dt>Cost</dt><dd>{formatMoney(progress.totalCost)}{progress.budgetLimit != null ? ` of $${progress.budgetLimit}` : ""}</dd>
        <dt>Model calls</dt><dd>{theater.modelCalls.length}</dd>
        <dt>Sources</dt><dd>{progress.sourceCount}</dd>
        <dt>Exports</dt><dd>{progress.exportCount}</dd>
      </dl>
    </section>
    <section className={`${ui.tile} ${ui.s6}`}>
      <div className={ui.tileHead}><h2>Quality checks</h2>{quality && <StatusBadge status={quality.status} />}</div>
      {quality ? <div className="px-3.5 pb-3">
        <dl className={ui.metadata}>{[["Evidence", quality.counts.evidence], ["Sources", quality.counts.sources], ["Valuation anchors", quality.counts.scenariosWithValueAnchors], ["Open gaps", quality.counts.openSourceGaps]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p className={`${ui.muted} mt-2`}>Readiness: {humanize(quality.actionReadiness)}</p>
        {blockers.length > 0 && <ul className="mt-2 list-disc pl-[18px]">{blockers.map((item, index) => <li key={index}>{item.description}</li>)}</ul>}
        {quality.errors.filter((error) => !blockers.some((item) => item.description === error)).map((error, index) => <p key={index} className={ui.error}>{error}</p>)}
        {quality.warnings.length > 0 && <details className={`${styles.fold} mt-2`}><summary>Warnings<span className={ui.muted}>{quality.warnings.length}</span></summary><ul>{quality.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      </div> : <p className={ui.empty}>Quality checks are not available yet.</p>}
    </section>
    <section className={`${ui.tile} ${ui.s6}`}>
      <div className={ui.tileHead}><h2>Activity</h2><span className={ui.muted}>{events.length}</span></div>
      <div className={styles.scroll}>
        {events.length ? events.map((event) => <div key={event.id} className={ui.row}><div><div className={ui.rowTitle}>{event.title}</div><p className={ui.rowMeta}>{event.detail} · {formatTime(event.time)}</p></div><StatusBadge status={event.status} /></div>) : <p className={ui.empty}>No activity yet.</p>}
      </div>
      <details className={styles.fold}><summary>Tasks<span className={ui.muted}>{progress.tasks.length}</span></summary>{progress.tasks.map((task) => <div key={task.id} className={ui.row}><div><div className={ui.rowTitle}>{task.agent_name || humanize(task.task_type)}</div><p className={ui.rowMeta}>{task.failure_reason || humanize(task.task_key)}</p></div><StatusBadge status={task.status} /></div>)}</details>
    </section>
    <section className={`${ui.tile} ${ui.s12}`}>
      <div className={ui.tileHead}><h2>Model calls</h2><span className={ui.muted}>{theater.modelCalls.length}</span></div>
      {theater.modelCalls.length ? <div className={`${ui.table} ${styles.scroll}`}><table><thead><tr><th>Agent</th><th>Model</th><th>Tier</th><th>Status</th><th className={ui.num}>Cost</th></tr></thead><tbody>
        {theater.modelCalls.map((call) => <tr key={call.id}><td>{call.agent_name || call.model_tier}{call.error_message && <div className={ui.error}>{call.error_message}</div>}</td><td className={ui.mono}>{call.model_provider}/{call.model_name}</td><td>{call.model_tier}</td><td><StatusBadge status={call.status} /></td><td className={ui.num}>{formatMoney(call.cost_usd)}</td></tr>)}
      </tbody></table></div> : <p className={ui.empty}>No model calls yet.</p>}
    </section>
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
  const [planForecastYears, setPlanForecastYears] = useState(5);
  const [planEdits, setPlanEdits] = useState<FramingEdits>({});
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
        body: JSON.stringify({ approved_by: "user", forecast_years: planForecastYears, ...planEdits }),
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
      setMessages((prev) => [...prev, { role: "system", content: "Redrafting the plan with your feedback. The plan gate reopens when the new draft is ready." }]);
      setPlanChangeNotes("");
      setPhase("pipeline");
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
      // The run route also returns the latest job and worker health, so /jobs is not polled.
      const [runRes, qualityRes, sourcesRes, tracesRes, modelCallsRes, backtestsRes] =
        await Promise.all([
          fetch(`/api/research-runs/${id}`),
          fetch(`/api/research-runs/${id}/quality`),
          fetch(`/api/research-runs/${id}/sources`),
          fetch(`/api/research-runs/${id}/agent-traces`),
          fetch(`/api/research-runs/${id}/model-calls?summary=1`),
          fetch(`/api/research-runs/${id}/backtests?summary=1`),
        ]);

      if (!runRes.ok) throw new Error("Unable to refresh this run.");
      const data = await runRes.json();
      const qualityData = qualityRes.ok ? await qualityRes.json() : null;
      const sources = sourcesRes.ok ? await sourcesRes.json() : [];
      const traces = tracesRes.ok ? await tracesRes.json() : [];
      const modelCalls = modelCallsRes.ok ? await modelCallsRes.json() : [];
      const backtests = backtestsRes.ok ? await backtestsRes.json() : [];
      const planWaiting = data.stages?.some((stage: any) => stage.stage_key === "research_plan" && stage.status === "waiting_for_human");
      // The page shows only the research plan, and only while it waits for approval.
      const planRes = planWaiting ? await fetch(`/api/research-runs/${id}/artifacts?type=research_plan`) : null;
      const artifactsData = planRes?.ok ? await planRes.json() : { artifacts: [] };
      if (!current()) return;
      const planArtifact = (artifactsData.artifacts || []).find((artifact: any) => artifact.type === "research_plan");
      if (planArtifact) {
        setResearchPlan(planArtifact.content_json || null);
        if (Number(planArtifact.content_json?.forecast_years) > 0) setPlanForecastYears(Number(planArtifact.content_json.forecast_years));
      }
      if (planWaiting) setPhase("plan");
      else if (phase === "plan") setPhase("pipeline");

      setProgress({
        runId: data.id,
        pipelineVersion: Number(data.pipeline_version || 0),
        status: data.status,
        latestJob: data.latest_job || null,
        workerHealthy: Boolean(data.worker_health?.healthy),
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
        requestReset: data.request_reset ?? null,
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
  const startNew = () => { activeRunRef.current = null; window.history.replaceState(null, "", `/assets/${assetId}/run?new=1`); setRunId(null); setProgress(null); setQuality(null); setResearchPlan(null); setPhase("intake"); setMessages([]); setTheater({ sources: [], traces: [], modelCalls: [], backtests: [] }); setLoadError(""); };

  return <div className={`${ui.page} ${ui.withBack}`}>
    <Link href={`/assets/${assetId}/view${runId ? `?run=${runId}` : ""}`} className={ui.back}><ArrowLeft size={14} />Research brief</Link>
    <AssetHero assetId={assetId} name={assetName || "Research"}
      meta={[phase === "intake" ? "New research run" : progress ? `Run ${progress.runId.slice(0, 8)}` : null]}
      status={phase !== "intake" && progress ? <StatusBadge status={progress.status} /> : undefined}
      actions={runId && progress && phase === "pipeline" ? <>
        <Link href={`/assets/${assetId}/view?run=${runId}`} className={ui.secondary}>Read research</Link>
        {!["completed", "cancelled"].includes(progress.status) && <button className={ui.secondary} onClick={handleCancelRun} disabled={isProcessing}>Cancel run</button>}
        <button className={ui.primary} onClick={startNew}>New research</button>
      </> : undefined} />
    {loadError && <p className={ui.error} role="alert">{loadError}{runId && <button onClick={() => fetchProgress(runId)}>Try again</button>}</p>}
    {lastMessage && !lastMessage.content.startsWith("Loaded research run") && <p className={`${ui.banner} ${ui.notes} ${ui.muted}`} role="status">{lastMessage.content}</p>}

    {phase === "intake" && !loadError ? <form className={ui.grid} onSubmit={(event) => { event.preventDefault(); handleSend(); }}>
      <section className={`${ui.tile} ${ui.s8}`}>
        <div className={ui.tileHead}><h2>Research question</h2></div>
        <div className={`${ui.form} ${ui.tileBody}`}>
          <label className={ui.field}><span className="sr-only">Research question</span><textarea rows={5} value={input} onChange={(event) => setInput(event.target.value)} placeholder={`What would you like to understand about ${assetName}?`} disabled={isProcessing} required /></label>
          <div className="flex flex-wrap gap-x-5 gap-y-1">{["Long-term investment thesis", "Update valuation"].map((label, index) => <button key={label} type="button" className={ui.textLink} onClick={() => setInput(index === 0 ? `Research ${assetName} as a long-term compounder` : "Update valuation with latest data")}>{label}</button>)}</div>
          <label className={ui.field}>Research type<select value={runType} onChange={(event) => setRunType(event.target.value)} disabled={isProcessing}>{[["quick_scan", "Quick scan"], ["deep_dive", "Deep dive"], ["thesis_investigation", "Thesis investigation"], ["full_initiation_report", "Full initiation report"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
      </section>
      <section className={`${ui.tile} ${ui.s4}`}>
        <div className={ui.tileHead}><h2>Budget and data cutoffs</h2></div>
        <div className={`${ui.form} ${ui.tileBody}`}>
          <label className={ui.field}>Budget (USD)<input type="number" min="0" step="0.01" value={budgetLimitUsd} onChange={(event) => setBudgetLimitUsd(event.target.value)} disabled={isProcessing} /></label>
          <label className={ui.field}>Source cutoff<input type="datetime-local" value={sourceCutoffAt} onChange={(event) => setSourceCutoffAt(event.target.value)} disabled={isProcessing} /></label>
          <label className={ui.field}>Market data cutoff<input type="datetime-local" value={marketDataCutoffAt} onChange={(event) => setMarketDataCutoffAt(event.target.value)} disabled={isProcessing} /></label>
        </div>
        <div className={ui.actions}><span className={ui.muted}>Stops first at the plan gate</span><button className={ui.primary} disabled={isProcessing || !input.trim()}>{isProcessing ? "Creating…" : "Create research plan"}</button></div>
      </section>
    </form> : phase === "plan" ? <div className={ui.grid}>
      <section className={`${ui.tile} ${ui.s8}`}>
        <div className={ui.tileHead}><h2>Gate 1 of 2: review research plan</h2><span className={ui.status} data-status="waiting_for_human">Waiting for you</span></div>
        {researchPlan && <div className="border-b border-[var(--line-soft)] [&>section]:m-0 [&>section]:rounded-none [&>section]:border-0"><FramingEditor key={`${researchPlan.generated_at}`} plan={researchPlan} disabled={isProcessing} onChange={setPlanEdits} /></div>}
        <ResearchPlanCard plan={researchPlan} />
      </section>
      <section className={`${ui.tile} ${ui.s4}`}>
        <div className={ui.tileHead}><h2>Your decision</h2></div>
        <div className={`${ui.form} ${ui.tileBody}`}>
          <ForecastYearsField value={planForecastYears} onChange={setPlanForecastYears} disabled={isProcessing} />
          <label className={ui.field}>Requested changes<textarea rows={4} value={planChangeNotes} onChange={(event) => setPlanChangeNotes(event.target.value)} disabled={isProcessing} /></label>
        </div>
        <div className={ui.actions}>
          <button className={ui.secondary} onClick={handleRequestPlanChanges} disabled={isProcessing || !planChangeNotes.trim()}>Request changes</button>
          <button className={ui.primary} onClick={handleApprovePlan} disabled={isProcessing}>{isProcessing ? "Saving…" : "Approve plan & start"}</button>
        </div>
      </section>
    </div> : progress ? <div className={ui.grid}>
      {finalReviewWaiting && <section className={`${ui.tile} ${ui.s12}`}>
        <div className={ui.tileHead}><h2>Gate 2 of 2: human review</h2><span className={ui.status} data-status="waiting_for_human">Waiting for you</span></div>
        <div className={`${ui.tileBody} flex flex-wrap items-center justify-between gap-3`}><p className={ui.muted}>The report and AI review are ready. Record a verdict to export the report and schedule refreshes.</p><Link className={ui.primary} href={`/review?run=${runId}`}>Review research</Link></div>
      </section>}
      {progress.requestReset && <section className={`${ui.tile} ${ui.s12}`} aria-label="Re-run approval">
        <div className={ui.tileHead}><h2>Approve a re-run?</h2><span className={ui.status} data-status="waiting_for_human">Waiting for you</span></div>
        <div className={ui.tileBody}>
          <p className={ui.muted}>A specialist asked to recompute its analysis to answer {progress.requestReset.request_ids.length === 1 ? "one report question" : `${progress.requestReset.request_ids.length} report questions`}. Re-running reopens {progress.requestReset.stages.length} stages; their earlier model calls cost {formatMoney(progress.requestReset.estimated_cost_usd)}. Skipping keeps the current analysis and lists the requests as open questions.</p>
          <ul className="mt-2">{progress.requestReset.stages.map((stage) => <li key={stage}>{stageLabel(stage)}</li>)}</ul>
        </div>
        <div className={ui.actions}>
          <button className={ui.secondary} onClick={() => handleRequestReset("skip")} disabled={isProcessing}>Skip re-run</button>
          <button className={ui.primary} onClick={() => handleRequestReset("rerun")} disabled={isProcessing}>{isProcessing ? "Saving…" : "Re-run stages"}</button>
        </div>
      </section>}
      <RunDetails progress={progress} theater={theater} quality={quality} messages={messages} />
      <section className={`${ui.tile} ${ui.s6}`}>
        <div className={ui.tileHead}><h2>Sources</h2><span className={ui.muted}>{theater.sources.length}</span></div>
        <div className={styles.scroll}>{theater.sources.length ? theater.sources.map((source) => <div key={source.id} className={ui.row}><div><div className={ui.rowTitle}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">{source.title}</a> : source.title}</div><p className={ui.rowMeta}>{[humanize(source.source_type), source.publisher].filter(Boolean).join(" · ")}</p></div></div>) : <p className={ui.empty}>No sources attached.</p>}</div>
        <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" aria-label="Upload source file" />
        {showLinkInput && <form className={`${ui.form} ${ui.tileBody}`} onSubmit={(event) => { event.preventDefault(); handleLinkAttach(); }}><label className={ui.field}>Source URL<input type="url" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} required disabled={isUploading} /></label><div className="flex gap-3"><button className={ui.primary} disabled={isUploading || !linkUrl.trim()}>Attach source</button><button type="button" className={ui.secondary} onClick={() => { setShowLinkInput(false); setLinkUrl(""); }}>Cancel</button></div></form>}
        <div className={ui.actions}><button className={ui.textLink} onClick={() => setShowLinkInput(!showLinkInput)} disabled={isUploading}>Attach link</button><button className={ui.secondary} onClick={() => fileInputRef.current?.click()} disabled={isUploading}>{isUploading ? "Attaching…" : "Attach file"}</button></div>
      </section>
      <section className={`${ui.tile} ${ui.s6}`}>
        <div className={ui.tileHead}><h2>Backtests</h2><span className={ui.muted}>{theater.backtests.length}</span></div>
        {theater.backtests.length ? theater.backtests.map((test) => <div key={test.id} className={ui.row}><div><div className={ui.rowTitle}>{test.strategy_name || `${test.symbol} backtest`}</div><p className={ui.rowMeta}>{test.error_message || test.strategy_prompt}</p></div><StatusBadge status={test.status} /></div>) : <p className={ui.empty}>No backtests for this run.</p>}
        <form className={`${ui.form} ${ui.tileBody}`} onSubmit={(event) => { event.preventDefault(); handleBacktestRequest(); }}><label className={ui.field}>Strategy<textarea rows={3} value={backtestPrompt} onChange={(event) => setBacktestPrompt(event.target.value)} disabled={isBacktestSubmitting} placeholder="Describe the strategy to test" required /></label><div><button className={ui.primary} disabled={isBacktestSubmitting || !backtestPrompt.trim()}>{isBacktestSubmitting ? "Queueing…" : "Queue backtest"}</button></div></form>
      </section>
    </div> : null}
  </div>;
}
