"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  Gauge,
  GitBranch,
  Layers3,
  Radio,
  ReceiptText,
  ShieldCheck,
  TerminalSquare,
  Zap,
} from "lucide-react";

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
    output_json: Record<string, unknown> | null;
  }[];
  sourceCount: number;
  exportCount: number;
  totalCost: number;
  createdAt?: string;
  marketDataCutoffAt?: string | null;
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

function compactId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "—";
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

function statusTone(status: string) {
  if (status === "completed" || status === "success") {
    return "bg-emerald-50 text-emerald-700 border-emerald-100";
  }
  if (status === "running") return "bg-amber-50 text-amber-700 border-amber-100";
  if (status === "failed" || status === "error") return "bg-rose-50 text-rose-700 border-rose-100";
  if (status === "skipped") return "bg-gray-50 text-gray-500 border-gray-100";
  return "bg-blue-50 text-blue-700 border-blue-100";
}

function dotTone(status: string) {
  if (status === "completed" || status === "success") return "bg-emerald-500";
  if (status === "running") return "bg-amber-500";
  if (status === "failed" || status === "error") return "bg-rose-500";
  if (status === "skipped") return "bg-gray-300";
  return "bg-blue-400";
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

function MetricTile({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
          {label}
        </span>
        <Icon className="h-4 w-4 text-gray-400" />
      </div>
      <div className="mt-2 font-mono text-[20px] font-bold text-black">{value}</div>
      <div className="mt-1 truncate text-[11px] text-gray-400">{detail}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${statusTone(
        status
      )}`}
    >
      {status}
    </span>
  );
}

function StageRail({ progress }: { progress: RunProgress }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 shadow-sm">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        {progress.stages.map((stage) => (
          <div
            key={stage.id}
            className={`min-h-20 rounded-md border px-3 py-2 ${
              stage.status === "running"
                ? "border-amber-200 bg-amber-50/60"
                : "border-gray-100 bg-[#fbfcfd]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${dotTone(stage.status)}`} />
                <span className="truncate text-[11px] font-bold uppercase tracking-wider text-gray-600">
                  {humanize(stage.key)}
                </span>
              </div>
              <span className="font-mono text-[10px] text-gray-400">
                {String(stage.order).padStart(2, "0")}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <StatusBadge status={stage.status} />
              <span className="font-mono text-[10px] text-gray-400">
                {formatTime(stage.completed_at || stage.started_at)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QualityGatesPanel({ quality }: { quality: ResearchQuality | null }) {
  const blockers = quality?.missingCoverage.filter((item) => item.requiredForCompletion) || [];
  const counts = quality?.counts;

  return (
    <div className="rounded-md border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-gray-400" />
            <h3 className="text-[14px] font-bold text-black">Quality Gates</h3>
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Research depth check for source breadth, evidence, valuation anchors, AI review, and human approval.
          </p>
        </div>
        {quality ? (
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={quality.status} />
            <StatusBadge status={quality.actionReadiness} />
          </div>
        ) : (
          <StatusBadge status="checking" />
        )}
      </div>

      {quality ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-md border border-gray-100 bg-[#fbfcfd] p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Sources</div>
              <div className="mt-1 font-mono text-[18px] font-bold text-black">{counts?.sources ?? 0}</div>
            </div>
            <div className="rounded-md border border-gray-100 bg-[#fbfcfd] p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Evidence</div>
              <div className="mt-1 font-mono text-[18px] font-bold text-black">{counts?.evidence ?? 0}</div>
            </div>
            <div className="rounded-md border border-gray-100 bg-[#fbfcfd] p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Valuation Anchors</div>
              <div className="mt-1 font-mono text-[18px] font-bold text-black">{counts?.scenariosWithValueAnchors ?? 0}</div>
            </div>
            <div className="rounded-md border border-gray-100 bg-[#fbfcfd] p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Open Gaps</div>
              <div className="mt-1 font-mono text-[18px] font-bold text-black">{counts?.openSourceGaps ?? 0}</div>
            </div>
          </div>

          <div className="mt-4 rounded-md border border-gray-100 bg-[#fbfcfd] p-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Top Blockers
            </div>
            {blockers.length === 0 ? (
              <div className="text-[12px] text-gray-500">No blocking quality gaps recorded.</div>
            ) : (
              <div className="space-y-2">
                {blockers.slice(0, 5).map((item) => (
                  <div key={`${item.key}-${item.description}`} className="grid grid-cols-[auto_1fr] gap-2 text-[12px]">
                    <span className={`mt-0.5 h-2 w-2 rounded-full ${item.severity === "critical" || item.severity === "high" ? "bg-rose-500" : "bg-amber-500"}`} />
                    <div>
                      <span className="font-semibold text-gray-700">{humanize(item.area)}:</span>{" "}
                      <span className="text-gray-500">{item.description}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-md border border-dashed border-gray-200 bg-[#fbfcfd] px-3 py-4 text-[12px] text-gray-400">
          Quality gates have not been evaluated yet.
        </div>
      )}
    </div>
  );
}

function ActiveStagePanel({
  progress,
  theater,
}: {
  progress: RunProgress;
  theater: TheaterData;
}) {
  const activeStage =
    progress.stages.find((stage) => stage.status === "running") ||
    progress.stages.find((stage) => stage.status === "pending") ||
    progress.stages[progress.stages.length - 1];
  const activeTasks = progress.tasks.filter((task) => task.stage_id === activeStage?.id);
  const blockedTasks = progress.tasks.filter((task) => task.status === "failed");

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
      <div className="rounded-md border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-amber-600" />
              <h3 className="text-[14px] font-bold text-black">
                {humanize(activeStage?.key || "research stage")}
              </h3>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Stage-centered control surface for active work.
            </p>
          </div>
          <StatusBadge status={activeStage?.status || "pending"} />
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Tasks
            </div>
            <div className="mt-1 font-mono text-[18px] font-bold text-black">
              {activeTasks.length}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Blockers
            </div>
            <div className="mt-1 font-mono text-[18px] font-bold text-black">
              {blockedTasks.length}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Sources
            </div>
            <div className="mt-1 font-mono text-[18px] font-bold text-black">
              {theater.sources.length}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Calls
            </div>
            <div className="mt-1 font-mono text-[18px] font-bold text-black">
              {theater.modelCalls.length}
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          {activeTasks.length === 0 ? (
            <div className="rounded-md border border-dashed border-gray-200 bg-[#fbfcfd] px-3 py-4 text-[12px] text-gray-400">
              No agent task is currently assigned to this stage.
            </div>
          ) : (
            activeTasks.slice(0, 4).map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between gap-3 rounded-md border border-gray-100 bg-[#fbfcfd] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-semibold text-black">
                    {task.agent_name || humanize(task.task_type)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400">
                    {humanize(task.task_key)} · retry {task.retry_count}
                  </div>
                </div>
                <StatusBadge status={task.status} />
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-gray-400" />
            <h3 className="text-[13px] font-bold text-black">Validation Gates</h3>
          </div>
          <span className="font-mono text-[10px] text-gray-400">
            {compactId(progress.runId)}
          </span>
        </div>
        <div className="space-y-2">
          {progress.stages.slice(0, 6).map((stage) => (
            <div key={stage.id} className="flex items-center justify-between gap-3 text-[12px]">
              <div className="min-w-0 truncate text-gray-600">{humanize(stage.key)}</div>
              <div className="flex items-center gap-2">
                {stage.validation_result_json ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                ) : stage.status === "failed" ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />
                ) : (
                  <Clock className="h-3.5 w-3.5 text-gray-300" />
                )}
                <StatusBadge status={stage.status} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentConsole({ progress, theater }: { progress: RunProgress; theater: TheaterData }) {
  const recentCalls = theater.modelCalls.slice(0, 5);
  const recentTraces = theater.traces.slice(0, 5);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Bot className="h-4 w-4 text-gray-400" />
          <h3 className="text-[13px] font-bold text-black">Agent Queue</h3>
        </div>
        <div className="space-y-2">
          {progress.tasks.length === 0 ? (
            <div className="text-[12px] text-gray-400">No tasks have been queued.</div>
          ) : (
            progress.tasks.slice(0, 7).map((task) => (
              <div key={task.id} className="rounded-md border border-gray-100 bg-[#fbfcfd] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-black">
                    {task.agent_name || humanize(task.task_type)}
                  </span>
                  <StatusBadge status={task.status} />
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-gray-400">
                  p{task.priority} · {compactId(task.id)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-gray-400" />
          <h3 className="text-[13px] font-bold text-black">Tool Traces</h3>
        </div>
        <div className="space-y-2">
          {recentTraces.length === 0 ? (
            <div className="text-[12px] text-gray-400">No tool traces recorded.</div>
          ) : (
            recentTraces.map((trace) => (
              <div key={trace.id} className="rounded-md border border-gray-100 bg-[#fbfcfd] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-black">
                    {trace.tool_name || "agent event"}
                  </span>
                  <StatusBadge status={trace.status} />
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-gray-400">
                  {trace.agent_name} · {formatTime(trace.created_at)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <ReceiptText className="h-4 w-4 text-gray-400" />
          <h3 className="text-[13px] font-bold text-black">Model Calls</h3>
        </div>
        <div className="space-y-2">
          {recentCalls.length === 0 ? (
            <div className="text-[12px] text-gray-400">No model calls recorded.</div>
          ) : (
            recentCalls.map((call) => (
              <div key={call.id} className="rounded-md border border-gray-100 bg-[#fbfcfd] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-black">
                    {call.agent_name || call.model_tier}
                  </span>
                  <span className="font-mono text-[10px] font-bold text-gray-500">
                    {formatMoney(call.cost_usd)}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-gray-400">
                  {call.model_provider}/{call.model_name}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ArtifactDeck({ theater }: { theater: TheaterData }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <FileText className="h-4 w-4 text-gray-400" />
          <h3 className="text-[13px] font-bold text-black">Source Intake</h3>
        </div>
        <div className="space-y-2">
          {theater.sources.length === 0 ? (
            <div className="text-[12px] text-gray-400">No sources attached yet.</div>
          ) : (
            theater.sources.slice(0, 5).map((source) => (
              <div key={source.id} className="rounded-md border border-gray-100 bg-[#fbfcfd] p-2">
                <div className="truncate text-[12px] font-semibold text-black">{source.title}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-gray-400">
                  {humanize(source.source_type)} · {source.publisher || "unpublished"}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Gauge className="h-4 w-4 text-gray-400" />
          <h3 className="text-[13px] font-bold text-black">Backtest Bench</h3>
        </div>
        <div className="space-y-2">
          {theater.backtests.length === 0 ? (
            <div className="text-[12px] text-gray-400">No backtests queued.</div>
          ) : (
            theater.backtests.slice(0, 5).map((backtest) => (
              <div key={backtest.id} className="rounded-md border border-gray-100 bg-[#fbfcfd] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-black">
                    {backtest.strategy_name || `${backtest.symbol} strategy`}
                  </span>
                  <StatusBadge status={backtest.status} />
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-gray-400">
                  {backtest.error_message || backtest.strategy_prompt}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const iconFor = (type: TimelineEvent["type"]) => {
    if (type === "stage") return GitBranch;
    if (type === "task") return Bot;
    if (type === "source") return FileText;
    if (type === "trace") return TerminalSquare;
    if (type === "model") return Zap;
    if (type === "backtest") return Gauge;
    return Activity;
  };

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-gray-400" />
          <h3 className="text-[13px] font-bold text-black">Event Stream</h3>
        </div>
        <span className="font-mono text-[10px] text-gray-400">{events.length} events</span>
      </div>
      <div className="space-y-2">
        {events.length === 0 ? (
          <div className="text-[12px] text-gray-400">No research events yet.</div>
        ) : (
          events.map((event) => {
            const Icon = iconFor(event.type);
            return (
              <div key={event.id} className="grid grid-cols-[18px_1fr_auto] gap-3 rounded-md border border-gray-100 bg-[#fbfcfd] p-2">
                <Icon className="mt-0.5 h-4 w-4 text-gray-400" />
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-semibold text-black">
                    {event.title}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400">{event.detail}</div>
                </div>
                <div className="text-right">
                  <StatusBadge status={event.status} />
                  <div className="mt-1 font-mono text-[10px] text-gray-400">
                    {formatTime(event.time)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ResearchPlanCard({ plan }: { plan: Record<string, any> | null }) {
  if (!plan) {
    return <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Research plan is still being prepared.</div>;
  }
  const list = (value: unknown) => Array.isArray(value) ? value : [];
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="rounded-md border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Research plan gate</div>
              <h1 className="mt-1 text-xl font-bold text-black">Review the persisted v3 plan</h1>
              <p className="mt-2 text-sm text-gray-500">{plan.research_question || "No research question recorded."}</p>
            </div>
            <StatusBadge status="waiting_for_human" />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricTile label="Stages" value={String(list(plan.applicable_stages).length)} detail="profile-derived" icon={Layers3} />
            <MetricTile label="Source roles" value={String(list(plan.required_source_roles).length)} detail="required roles" icon={Database} />
            <MetricTile label="Modules" value={String(list(plan.required_analysis_modules).length)} detail="analysis outputs" icon={FileText} />
            <MetricTile label="Budget" value={plan.budget?.limit_usd ? `$${plan.budget.limit_usd}` : "Open"} detail="server-stored limit" icon={Gauge} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PlanList title="Composed profile" values={[...(list(plan.composed_archetypes).map(String)), ...(list(plan.overlays).map((value) => `Overlay: ${value}`))]} />
          <PlanList title="Valuation methods" values={list(plan.valuation_methods).map((method) => `${method.method || method.method_key || "method"}: ${method.allowed === false ? "forbidden" : "allowed"}`)} />
          <PlanList title="Required source roles" values={list(plan.required_source_roles).map((role) => `${role.role} — ${role.required === false ? "optional" : "required"}`)} />
          <PlanList title="Required analysis modules" values={list(plan.required_analysis_modules).map((module) => `${module.artifact_type} — ${module.required === false ? "optional" : "required"}`)} />
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-gray-400">Applicable stages</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {list(plan.applicable_stages).map((stage) => (
              <div key={stage.key} className="flex items-center gap-2 rounded border border-gray-100 bg-[#fbfcfd] px-3 py-2 text-xs">
                <span className="font-mono text-gray-400">{String(stage.order).padStart(2, "0")}</span>
                <span className="font-semibold text-gray-700">{stage.name || humanize(stage.key)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-gray-500">
            Source cutoff: {plan.cutoffs?.source_cutoff_at ? new Date(plan.cutoffs.source_cutoff_at).toLocaleString() : "not set"} · Market cutoff: {plan.cutoffs?.market_data_cutoff_at ? new Date(plan.cutoffs.market_data_cutoff_at).toLocaleString() : "not set"}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanList({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">{title}</div>
      {values.length === 0 ? <div className="text-xs text-gray-400">No persisted entries.</div> : (
        <ul className="space-y-1 text-xs text-gray-600">{values.map((value, index) => <li key={`${value}-${index}`}>• {value}</li>)}</ul>
      )}
    </div>
  );
}

function ResearchTheater({
  assetName,
  progress,
  theater,
  messages,
  quality,
}: {
  assetName: string;
  progress: RunProgress;
  theater: TheaterData;
  messages: Message[];
  quality: ResearchQuality | null;
}) {
  const completedStages = progress.stages.filter((stage) => stage.status === "completed").length;
  const runningTasks = progress.tasks.filter((task) => task.status === "running").length;
  const failedTasks = progress.tasks.filter((task) => task.status === "failed").length;
  const events = buildTimeline(progress, theater, messages);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">
              <Radio className="h-3.5 w-3.5" />
              Mission Control
            </div>
            <h1 className="text-[24px] font-bold tracking-tight text-black">
              {assetName || "Research Run"}
            </h1>
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-gray-500">
              Run {compactId(progress.runId)} · v{progress.pipelineVersion} · {humanize(progress.status)} · {progress.latestJob ? `job ${humanize(progress.latestJob.status)}` : "no job"}
              {!progress.workerHealthy && progress.latestJob?.status === "queued" ? " · waiting for worker" : ""}
              {progress.marketDataCutoffAt
                ? ` · data cutoff ${new Date(progress.marketDataCutoffAt).toLocaleDateString()}`
                : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={progress.status} />
            <span className="rounded-full border border-gray-200 bg-white px-3 py-1 font-mono text-[11px] font-bold text-gray-600">
              {formatMoney(progress.totalCost)}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile
            label="Stages"
            value={`${completedStages}/${progress.stages.length}`}
            detail="completed gates"
            icon={Layers3}
          />
          <MetricTile
            label="Agents"
            value={String(runningTasks)}
            detail={`${progress.tasks.length} tasks total`}
            icon={Bot}
          />
          <MetricTile
            label="Sources"
            value={String(theater.sources.length)}
            detail="attached to this run"
            icon={Database}
          />
          <MetricTile
            label="Blockers"
            value={String(failedTasks)}
            detail="failed tasks"
            icon={AlertTriangle}
          />
        </div>

        <QualityGatesPanel quality={quality} />
        <StageRail progress={progress} />
        <ActiveStagePanel progress={progress} theater={theater} />
        <AgentConsole progress={progress} theater={theater} />
        <ArtifactDeck theater={theater} />
        <Timeline events={events} />
      </div>
    </div>
  );
}

export default function RunResearchPage() {
  const params = useParams();
  const router = useRouter();
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    async function loadAssetContext() {
      try {
        const [assetRes, runsRes] = await Promise.all([
          fetch(`/api/assets/${assetId}`),
          fetch(`/api/assets/${assetId}/research-runs`),
        ]);
        if (assetRes.ok) {
          const data = await assetRes.json();
          setAssetName(data.canonical_name);
        }
        if (runsRes.ok) {
          const runs = await runsRes.json();
          const latestRun = Array.isArray(runs)
            ? [...runs]
                .sort(
                  (a, b) =>
                    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                )[0]
            : null;
          if (latestRun) {
            setRunId(latestRun.id);
            setPhase("pipeline");
            setMessages((prev) =>
              prev.length === 0
                ? [
                    {
                      role: "system",
                      content: `Loaded latest research run: ${latestRun.id}`,
                    },
                  ]
                : prev
            );
            fetchProgress(latestRun.id);
          }
        }
      } catch (error) {
        console.error("Failed to load asset context:", error);
      }
    }
    loadAssetContext();
  }, [assetId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!runId || phase !== "pipeline") return;
    const interval = window.setInterval(() => fetchProgress(runId), 5000);
    return () => window.clearInterval(interval);
  }, [runId, phase]);

  async function handleSend() {
    if (!input.trim() || isProcessing) return;

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
      setRunId(run.id);
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

  async function fetchProgress(id: string) {
    try {
      const [runRes, qualityRes, sourcesRes, tracesRes, modelCallsRes, backtestsRes, jobsRes, artifactsRes] =
        await Promise.all([
          fetch(`/api/research-runs/${id}`),
          fetch(`/api/research-runs/${id}/quality`),
          fetch(`/api/research-runs/${id}/sources`),
          fetch(`/api/research-runs/${id}/agent-traces`),
          fetch(`/api/research-runs/${id}/model-calls`),
          fetch(`/api/research-runs/${id}/backtests`),
          fetch(`/api/research-runs/${id}/jobs`),
          fetch(`/api/research-runs/${id}/artifacts`),
        ]);

      const data = await runRes.json();
      const qualityData = qualityRes.ok ? await qualityRes.json() : null;
      const sources = sourcesRes.ok ? await sourcesRes.json() : [];
      const traces = tracesRes.ok ? await tracesRes.json() : [];
      const modelCalls = modelCallsRes.ok ? await modelCallsRes.json() : [];
      const backtests = backtestsRes.ok ? await backtestsRes.json() : [];
      const jobsData = jobsRes.ok ? await jobsRes.json() : { latestJob: null, workers: [] };
      const artifactsData = artifactsRes.ok ? await artifactsRes.json() : { artifacts: [] };
      const planArtifact = (artifactsData.artifacts || []).find((artifact: any) => artifact.type === "research_plan");
      const planWaiting = data.stages?.some((stage: any) => stage.stage_key === "research_plan" && stage.status === "waiting_for_human");
      if (planArtifact) setResearchPlan(planArtifact.content || planArtifact.content_json || null);
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
          output_json: t.output_json,
        })),
        sourceCount: Array.isArray(sources) ? sources.length : 0,
        exportCount: data.metadata_json?.export_count || 0,
        totalCost: parseFloat(data.actual_cost_usd || "0"),
        createdAt: data.created_at,
        marketDataCutoffAt: data.market_data_cutoff_at,
      });

      setTheater({
        sources: Array.isArray(sources) ? sources : [],
        traces: Array.isArray(traces) ? traces : [],
        modelCalls: Array.isArray(modelCalls) ? modelCalls : [],
        backtests: Array.isArray(backtests) ? backtests : [],
      });
      setQuality(qualityData);
    } catch (error) {
      console.error("Failed to fetch progress:", error);
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

  return (
    <div className="flex flex-col h-screen bg-[#f4f7fa]">
      {/* Top Header */}
      <div className="border-b border-[#eef2f6] bg-white px-6 py-3.5 flex items-center justify-between shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-black transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span>Back</span>
          </button>
          <span className="text-gray-300">|</span>
          <h2 className="text-[14px] font-bold text-black">
            Run Research &rsaquo; <span className="text-gray-500 font-semibold">{assetName}</span>
          </h2>
        </div>
        <div>
          <select
            value={runType}
            onChange={(e) => setRunType(e.target.value)}
            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12px] font-semibold text-gray-600 focus:outline-none focus:border-black cursor-pointer transition-colors"
          >
            <option value="quick_scan">Quick Scan</option>
            <option value="deep_dive">Deep Dive</option>
            <option value="valuation_refresh">Valuation Refresh</option>
            <option value="thesis_investigation">Thesis Investigation</option>
            <option value="full_initiation_report">Full Initiation Report</option>
          </select>
          <div className="mt-2 grid grid-cols-3 gap-1">
            <input type="datetime-local" value={sourceCutoffAt} onChange={(event) => setSourceCutoffAt(event.target.value)} title="Source cutoff" className="w-full rounded border border-gray-200 px-2 py-1 text-[10px] text-gray-500" />
            <input type="datetime-local" value={marketDataCutoffAt} onChange={(event) => setMarketDataCutoffAt(event.target.value)} title="Market-data cutoff" className="w-full rounded border border-gray-200 px-2 py-1 text-[10px] text-gray-500" />
            <input type="number" min="0" step="0.01" value={budgetLimitUsd} onChange={(event) => setBudgetLimitUsd(event.target.value)} placeholder="Budget $" className="w-full rounded border border-gray-200 px-2 py-1 text-[10px] text-gray-500" />
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Main Panel */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Conversation history view */}
          {phase === "pipeline" && progress ? (
            <ResearchTheater
              assetName={assetName}
              progress={progress}
              theater={theater}
              messages={messages}
              quality={quality}
            />
          ) : phase === "plan" && progress ? (
            <ResearchPlanCard plan={researchPlan} />
          ) : (
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && (
              <div className="text-center py-16 max-w-xl mx-auto flex flex-col items-center">
                <div className="h-12 w-12 rounded-xl bg-white border border-gray-200/60 shadow-sm flex items-center justify-center text-gray-400 mb-4">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                  </svg>
                </div>
                <h3 className="text-[16px] font-bold text-black mb-2">
                  Research {assetName}
                </h3>
                <p className="text-xs text-gray-400 max-w-sm leading-normal">
                  Propose your investment questions. The pipeline will construct a plan before executing LLM routing calls.
                </p>
                
                <div className="mt-8 flex flex-wrap justify-center gap-2">
                  {[
                    `Research ${assetName} as a long-term compounder`,
                    `Update valuation with latest data`,
                    `Is ${assetName} cheap on key metrics?`,
                    `Build a DCF and compare with reverse DCF`,
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setInput(suggestion)}
                      className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-[12px] font-semibold text-gray-600 hover:border-gray-300 hover:text-black transition-all shadow-sm"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-2xl rounded-2xl px-4.5 py-3 shadow-sm text-left leading-normal ${
                    msg.role === "user"
                      ? "bg-black text-white rounded-br-none"
                      : msg.role === "system"
                      ? "bg-[#fafbfc] border border-gray-200/50 text-gray-500 text-[11.5px] font-mono rounded-bl-none"
                      : "bg-white border border-gray-200/80 text-black rounded-bl-none"
                  }`}
                >
                  <pre className="whitespace-pre-wrap font-sans text-[13px]">
                    {msg.content}
                  </pre>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          )}

          {/* User Input controls */}
          <div className="border-t border-[#eef2f6] bg-white p-4.5 shrink-0 shadow-sm">
            {phase === "plan" && (
              <div className="mb-4 space-y-2">
                <textarea
                  value={planChangeNotes}
                  onChange={(event) => setPlanChangeNotes(event.target.value)}
                  placeholder="Optional notes for requested plan changes"
                  className="min-h-16 w-full rounded-md border border-gray-200 bg-[#fbfcfd] px-3 py-2 text-xs outline-none focus:border-gray-400"
                  disabled={isProcessing}
                />
                <div className="flex gap-2">
                <button
                  onClick={handleApprovePlan}
                  className="rounded-full bg-emerald-600 px-5 py-2 text-[12px] font-bold text-white hover:bg-emerald-700 shadow-sm transition-all flex items-center gap-1.5"
                  disabled={isProcessing}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <span>Approve & Start Research</span>
                </button>
                <button
                  onClick={handleRequestPlanChanges}
                  disabled={isProcessing || !planChangeNotes.trim()}
                  className="rounded-full border border-gray-200 bg-white px-5 py-2 text-[12px] font-bold text-gray-600 hover:text-black hover:border-gray-300 transition-all"
                >
                  Request Changes
                </button>
                </div>
              </div>
            )}
            
            <div className="flex gap-2">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!runId || isUploading}
                className={`rounded-full border border-gray-200 p-2.5 flex items-center justify-center transition-all ${
                  runId && !isUploading
                    ? "text-gray-400 hover:text-black hover:border-gray-300 bg-white"
                    : "text-gray-200 bg-gray-50/50 cursor-not-allowed border-gray-100"
                }`}
                title={runId ? "Attach file" : "Create a run first to attach files"}
              >
                <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 11-2.828-2.828l6.414-6.414a4 4 0 015.656 5.656l-6.415 6.415a6 6 0 01-8.486-8.486L10.5 10" />
                </svg>
              </button>
              <button
                onClick={() => setShowLinkInput(!showLinkInput)}
                disabled={!runId || isUploading}
                className={`rounded-full border border-gray-200 p-2.5 flex items-center justify-center transition-all ${
                  runId && !isUploading
                    ? "text-gray-400 hover:text-black hover:border-gray-300 bg-white"
                    : "text-gray-200 bg-gray-50/50 cursor-not-allowed border-gray-100"
                }`}
                title={runId ? "Attach link" : "Create a run first to attach links"}
              >
                <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </button>
              
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
                placeholder={
                  phase === "intake"
                    ? "Describe your research question..."
                    : "Ask a follow-up or add context..."
                }
                className="flex-1 rounded-full border border-gray-200 px-5 py-2.5 text-[13px] font-mono focus:border-blue-500 focus:outline-none focus:ring-0 bg-[#fafbfc] focus:bg-white transition-all h-11"
                disabled={isProcessing}
              />
              
              <button
                onClick={handleSend}
                className="rounded-full bg-black px-6 h-11 text-[12px] font-bold text-white hover:bg-black/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                disabled={isProcessing || !input.trim()}
              >
                Send
              </button>
            </div>

            {showLinkInput && runId && (
              <div className="flex gap-2 mt-2">
                <input
                  type="url"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLinkAttach()}
                  placeholder="Paste a URL to ingest..."
                  className="flex-1 rounded-full border border-gray-200 px-5 py-2.5 text-[13px] font-mono focus:border-blue-500 focus:outline-none bg-[#fafbfc] transition-all h-11"
                  disabled={isUploading}
                />
                <button
                  onClick={handleLinkAttach}
                  disabled={isUploading || !linkUrl.trim()}
                  className="rounded-full bg-black px-5 h-11 text-[12px] font-bold text-white hover:bg-black/90 disabled:opacity-30 transition-all"
                >
                  Ingest URL
                </button>
                <button
                  onClick={() => { setShowLinkInput(false); setLinkUrl(""); }}
                  className="rounded-full border border-gray-200 bg-white px-5 h-11 text-[12px] font-bold text-gray-500 hover:text-black hover:border-gray-300 transition-all"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Pipeline Progress Sidebar */}
        {phase === "pipeline" && progress && (
          <div className="w-80 border-l border-[#eef2f6] bg-white overflow-y-auto p-5 shrink-0 shadow-sm z-20 flex flex-col gap-6">
            <div>
              <h3 className="font-bold text-[14px] text-black mb-1">
                Pipeline Progress
              </h3>
              <p className="text-[11px] text-gray-400">
                Orchestrator pipeline stage validation.
              </p>
            </div>

            {/* Run ID Status & Cost */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-[#fbfcfd] p-3">
                <div>
                  <span className="text-[10px] text-gray-400 uppercase tracking-wider font-bold block">Status</span>
                  <span className="rounded-full bg-yellow-50 text-yellow-700 text-[10px] font-bold uppercase tracking-wider inline-block mt-0.5">
                    {progress.status}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-gray-400 uppercase tracking-wider font-bold block">LiteLLM Cost</span>
                  <span className="text-xs font-mono font-bold text-black block mt-0.5">
                    ${progress.totalCost.toFixed(4)}
                  </span>
                </div>
              </div>
            </div>

            {/* Stages status list */}
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-gray-400 font-bold mb-3">Stages</h4>
              <div className="space-y-1.5 font-mono text-[11px]">
                {progress.stages.map((stage) => (
                  <div
                    key={stage.key}
                    className="flex items-center gap-2 px-2 py-1"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        stage.status === "completed"
                          ? "bg-emerald-500"
                          : stage.status === "running"
                          ? "bg-amber-500 animate-pulse"
                          : stage.status === "failed"
                          ? "bg-rose-500"
                          : stage.status === "skipped"
                          ? "bg-gray-300"
                          : "bg-gray-200"
                      }`}
                    />
                    <span
                      className={`uppercase tracking-wider ${
                        stage.status === "running"
                          ? "font-semibold text-black"
                          : "text-gray-500"
                      }`}
                    >
                      {stage.key.replace(/_/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Agent Tasks */}
            {progress.tasks && progress.tasks.length > 0 && (
              <div>
                <h4 className="text-[11px] uppercase tracking-wider text-gray-400 font-bold mb-3">Agent Tasks</h4>
                <div className="space-y-1.5 font-mono text-[11px]">
                  {progress.tasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-2">
                      <span className={`h-1 w-1 rounded-full ${
                        task.status === "completed" ? "bg-emerald-500" :
                        task.status === "running" ? "bg-amber-500 animate-pulse" : "bg-gray-300"
                      }`} />
                      <span className="text-gray-600 truncate">{task.agent_name || task.task_type}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Backtest request */}
            {runId && (
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
                    Backtest
                  </h4>
                  <span className="font-mono text-[10px] text-gray-400">
                    opencode
                  </span>
                </div>
                <textarea
                  value={backtestPrompt}
                  onChange={(e) => setBacktestPrompt(e.target.value)}
                  placeholder="Moving-average trend strategy with 50/200 day windows"
                  className="min-h-20 w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11.5px] text-gray-700 outline-none transition-all focus:border-blue-500"
                  disabled={isBacktestSubmitting}
                />
                <button
                  onClick={handleBacktestRequest}
                  disabled={isBacktestSubmitting || !backtestPrompt.trim()}
                  className="mt-2 w-full rounded-full bg-black px-4 py-2 text-[11px] font-bold text-white transition-all hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {isBacktestSubmitting ? "Queueing..." : "Queue Backtest"}
                </button>
              </div>
            )}

            {/* Sources metrics card */}
            {progress.sourceCount > 0 && (
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-3 flex justify-between items-center text-xs">
                <span className="font-semibold text-gray-500">Ingested Sources</span>
                <span className="font-bold text-black">{progress.sourceCount} files</span>
              </div>
            )}

            {/* Artifacts metrics card */}
            {progress.exportCount > 0 && (
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-3 flex justify-between items-center text-xs">
                <span className="font-semibold text-gray-500">Generated Reports</span>
                <span className="font-bold text-black">{progress.exportCount} exports</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
