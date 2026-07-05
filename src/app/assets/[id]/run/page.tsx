"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface RunProgress {
  runId: string;
  status: string;
  currentStage: string | null;
  stages: {
    key: string;
    order: number;
    status: string;
  }[];
  tasks: {
    id: string;
    agent_name: string | null;
    task_type: string;
    status: string;
  }[];
  sourceCount: number;
  exportCount: number;
  totalCost: number;
}

export default function RunResearchPage() {
  const params = useParams();
  const router = useRouter();
  const assetId = params.id as string;

  const [phase, setPhase] = useState<"intake" | "plan" | "pipeline">("intake");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [assetName, setAssetName] = useState("");
  const [researchPlan, setResearchPlan] = useState<string | null>(null);
  const [runType, setRunType] = useState("deep_dive");
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/assets/${assetId}`)
      .then((r) => r.json())
      .then((data) => setAssetName(data.canonical_name));
  }, [assetId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || isProcessing) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsProcessing(true);

    if (phase === "intake") {
      // Generate a research plan based on user input
      const plan = generateResearchPlan(userMessage);
      setResearchPlan(plan);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: plan },
      ]);
      setPhase("plan");
    }

    setIsProcessing(false);
  }

  function generateResearchPlan(userInput: string): string {
    const isDCF = !userInput.toLowerCase().includes("bitcoin") &&
      !userInput.toLowerCase().includes("crypto");

    return `## Research Plan

**Asset**: ${assetName}
**Run Type**: ${runType.replace(/_/g, " ")}
**Detected Profile**: ${isDCF ? "Operating Company" : "Bitcoin / Crypto Asset"}

### Planned Stages:
1. **Intake** — Understand research intent ✓
2. **Asset Identity** — Confirm asset profile and classification
3. **Research Plan** — Approve this plan
4. **Source Discovery** — Find relevant filings, reports, data sources
5. **Source Ingestion** — Parse and extract text/tables from sources
6. **Evidence Extraction** — Extract fact/estimate/assumption/opinion claims with source links
7. **Metric Normalization** — Standardize financial metrics and observations
8. **Asset Analysis** — ${isDCF ? "Business segments, revenue drivers, margins, competitive position" : "Network metrics, adoption, liquidity cycle, regulatory landscape"}
9. **Asset Valuation** — ${isDCF ? "DCF, reverse DCF, PE, EV/EBITDA signals" : "MVRV, realized price, drawdown, flow signals (DCF not applicable)"}
10. **Thesis & Risks** — Synthesize investment thesis, drivers, and key risks
11. **Review** — AI reviewer checks, then human approval
12. **Export** — Generate research memo

### Research Question:
${userInput}

Ready to start research?`;
  }

  async function handleApprovePlan() {
    setPhase("pipeline");
    setIsProcessing(true);
    setMessages((prev) => [
      ...prev,
      { role: "system", content: "Starting research pipeline..." },
    ]);

    try {
      // Create the research run
      const res = await fetch(`/api/assets/${assetId}/research-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_type: runType,
          research_question: messages.find((m) => m.role === "user")?.content || "",
          requested_by: "user",
        }),
      });
      const run = await res.json();
      setRunId(run.id);

      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `Research run created: ${run.id}\nStatus: ${run.status}\nStages initialized.`,
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

  async function fetchProgress(id: string) {
    try {
      const res = await fetch(`/api/research-runs/${id}`);
      const data = await res.json();

      // Fetch source count
      let sourceCount = 0;
      try {
        const sourcesRes = await fetch(`/api/research-runs/${id}/sources`);
        if (sourcesRes.ok) {
          const sources = await sourcesRes.json();
          sourceCount = Array.isArray(sources) ? sources.length : 0;
        }
      } catch { /* non-critical */ }

      setProgress({
        runId: data.id,
        status: data.status,
        currentStage: data.stages?.find((s: any) => s.status === "running")?.stage_key || null,
        stages: data.stages?.map((s: any) => ({
          key: s.stage_key,
          order: s.stage_order,
          status: s.status,
        })) || [],
        tasks: (data.tasks || []).map((t: any) => ({
          id: t.id,
          agent_name: t.agent_name,
          task_type: t.task_type,
          status: t.status,
        })),
        sourceCount,
        exportCount: data.metadata_json?.export_count || 0,
        totalCost: parseFloat(data.actual_cost_usd || "0"),
      });
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
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Main Panel */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Conversation history view */}
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

          {/* User Input controls */}
          <div className="border-t border-[#eef2f6] bg-white p-4.5 shrink-0 shadow-sm">
            {phase === "plan" && (
              <div className="mb-4 flex gap-2">
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
                  onClick={() => {
                    setPhase("intake");
                    setResearchPlan(null);
                  }}
                  className="rounded-full border border-gray-200 bg-white px-5 py-2 text-[12px] font-bold text-gray-600 hover:text-black hover:border-gray-300 transition-all"
                >
                  Modify Plan
                </button>
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
