"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  MetricHistoryChart,
  ValuationSignalChart,
  ResearchCostChart,
  PipelineProgressChart,
} from "@/components/charts";

interface Artifact {
  id: string;
  type: string;
  title: string;
  date: string;
  status: string;
  runId?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

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

export default function ViewResearchPage() {
  const params = useParams();
  const router = useRouter();
  const assetId = params.id as string;

  const [assetDetail, setAssetDetail] = useState<AssetDetail | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>("raw_data");
  const [searchQuery, setSearchQuery] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [loading, setLoading] = useState(true);

  // Chart data state
  const [metrics, setMetrics] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [costData, setCostData] = useState<any[]>([]);
  const [stages, setStages] = useState<any[]>([]);

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

        if (assetRes.ok && runsRes.ok) {
          const assetData = await assetRes.json();
          setAssetDetail(assetData);

          const runsData = await runsRes.json();
          setRuns(runsData);
        }
        if (metricsRes.ok) setMetrics(await metricsRes.json());
        if (signalsRes.ok) setSignals(await signalsRes.json());
        if (costRes.ok) setCostData(await costRes.json());
        if (stagesRes.ok) setStages(await stagesRes.json());
      } catch (error) {
        console.error("Failed to load research archive:", error);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [assetId]);

  async function handleChat() {
    if (!chatInput.trim()) return;

    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);

    setTimeout(() => {
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `I can help you explore research for ${assetDetail?.canonical_name}. This is a contextual chatbot that will use accepted evidence, metrics, and valuation signals from the database to answer your questions.\n\nCurrently, this is a placeholder response. The full implementation will:\n- Search accepted evidence claims\n- Query metric observations\n- Reference valuation signals\n- Cite source documents\n\nYour question: "${userMsg}"`,
        },
      ]);
    }, 500);
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f4f7fa] font-mono text-[13px] text-gray-500">
        Initializing workspace archive...
      </div>
    );
  }

  if (!assetDetail) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f4f7fa] font-mono text-red-500">
        Asset configuration profile not found.
      </div>
    );
  }

  // Define dynamic metadata based on active folder selection
  const folderConfig = {
    raw_data: {
      name: "Raw data",
      count: 3,
      size: "180.2 MB",
      desc: "Raw filings, PDF documents, and investor call transcripts loaded into memory.",
      progressDocs: 90,
      progressRuns: 10,
      items: [
        { name: `${assetDetail.slug}-annual-filing-2025.pdf`, detail: "10-K SEC Filing", type: "pdf", size: "142.1 MB" },
        { name: `${assetDetail.slug}-earnings-call-transcript.docx`, detail: "Q4 Earnings Call", type: "doc", size: "18.5 MB" },
        { name: `${assetDetail.slug}-commodity-supply-report.xlsx`, detail: "Third-party supply report", type: "xls", size: "19.6 MB" },
      ]
    },
    research_runs: {
      name: "Research runs",
      count: runs.length || 1,
      size: "490 KB",
      desc: "LangGraph autonomous orchestrator executions and active staging runs.",
      progressDocs: 15,
      progressRuns: 85,
      items: runs.map((run) => ({
        name: `${run.run_type.replace(/_/g, " ")}`,
        detail: `Status: ${run.status} · ${new Date(run.created_at).toLocaleDateString()}`,
        type: "run",
        size: `${run.status === "completed" ? "42 KB" : "12 KB"}`
      }))
    },
    valuation: {
      name: "Valuation models",
      count: 2,
      size: "1.3 MB",
      desc: "Discounted Cash Flows, reverse DCFs, and cap rate models constructed by agents.",
      progressDocs: 50,
      progressRuns: 60,
      items: [
        { name: `${assetDetail.slug}_dcf_base_case.xlsx`, detail: "Discounted Cash Flow Sheets", type: "xls", size: "850 KB" },
        { name: `${assetDetail.slug}_fundamental_multiples.xlsx`, detail: "Valuation ratios & reverse metrics", type: "xls", size: "480 KB" },
      ]
    },
    evidence: {
      name: "Evidence claims",
      count: 21,
      size: "23.4 MB",
      desc: "Structured claims linked directly to spatial page coordinates on source PDF sheets.",
      progressDocs: 80,
      progressRuns: 30,
      items: [
        { name: "Services Gross Margin expansion coordinates", detail: "AAPL 10-K P.42 -> coordinates: [30, 155, 420, 25]", type: "evidence", size: "Claim #1" },
        { name: "Greater China shipment volumes estimate", detail: "Gartner Supply Q4 -> coordinates: [40, 80, 380, 40]", type: "evidence", size: "Claim #2" },
        { name: "Silicon architecture R&D cost increments", detail: "AAPL 10-K P.18 -> coordinates: [30, 220, 440, 30]", type: "evidence", size: "Claim #3" },
      ]
    },
    metrics: {
      name: "Processed data",
      count: 96,
      size: "1.3 GB",
      desc: "Normalized fundamental fundamental figures and observations stored in ChromaDB.",
      progressDocs: 100,
      progressRuns: 45,
      items: [
        { name: "Vector collection 'provenance_chunks'", detail: "Ingested chunks: 14,241", type: "db", size: "840 MB" },
        { name: "Vector collection 'institutional_memory'", detail: "Ingested chunks: 2,421", type: "db", size: "480 MB" },
      ]
    },
    memos: {
      name: "Ideas and Insights",
      count: 2,
      size: "126.3 KB",
      desc: "Final PowerPoint, Word, and Excel artifacts generated by the production agents.",
      progressDocs: 30,
      progressRuns: 95,
      items: [
        { name: `${assetDetail.slug}_investment_thesis.docx`, detail: "Completed investment brief", type: "doc", size: "82 KB" },
        { name: `${assetDetail.slug}_pitch_deck.pptx`, detail: "Valuation presentation slides", type: "pptx", size: "44.3 KB" },
      ]
    },
    charts: {
      name: "Charts & Visualizations",
      count: metrics.length + signals.length + costData.length + stages.length,
      size: "Interactive",
      desc: "Metric trends, valuation signals, research cost breakdown, and pipeline progress visualizations.",
      progressDocs: 100,
      progressRuns: 100,
      items: [] // Charts render inline instead of file items
    }
  };

  const selectedFolder = folderConfig[activeFolder as keyof typeof folderConfig] || folderConfig.raw_data;

  // Filter folder items based on search query
  const filteredItems = selectedFolder.items.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.detail.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen bg-[#f4f7fa] overflow-hidden">
      {/* 1. Main Workspace (Middle Column) */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#f4f7fa] p-6 pr-3 overflow-y-auto">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-400 mb-2">
          <span>Projects</span>
          <span>
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
            </svg>
          </span>
          <span className="text-gray-500 font-semibold">{assetDetail.canonical_name}</span>
        </div>

        {/* Title and Top Action Toolbar */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold tracking-tight text-black">{assetDetail.canonical_name}</h2>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-[12px] font-medium text-gray-600 hover:text-black hover:border-gray-300 shadow-sm transition-all">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              </svg>
              <span>Manage</span>
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-[12px] font-medium text-gray-600 hover:text-black hover:border-gray-300 shadow-sm transition-all">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.684 10.742l-1.922-.641A3.001 3.001 0 1110 8c0 .26-.032.512-.093.753l1.848.616A2.996 2.996 0 0113 9a3 3 0 01-1.316 2.492l1.922.641A3.001 3.001 0 1114 16c0-.26-.032-.512-.093-.753l-1.848-.616A2.996 2.996 0 0111 15a3 3 0 01-1.316-2.492z" />
              </svg>
              <span>Share</span>
            </button>
            <Link
              href={`/assets/${assetId}/run`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black text-white text-[12px] font-medium hover:bg-black/90 shadow-sm transition-all"
            >
              <span>New draft</span>
            </Link>
          </div>
        </div>        {/* Search and Filters Toolbar */}
        <div className="flex gap-2.5 mb-6">
          <div className="relative flex-1 flex items-center">
            <span className="absolute left-4 text-gray-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents, runs, models..."
              className="w-full pl-11 pr-4 h-11 rounded-full border border-gray-200 bg-white text-[13.5px] focus:outline-none focus:border-blue-500 transition-all font-mono"
            />
          </div>
          <button className="flex items-center gap-1.5 px-5 h-11 rounded-full border border-gray-200 bg-white text-[12px] font-semibold text-gray-600 hover:text-black hover:border-gray-300 shadow-sm transition-all shrink-0">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            <span>Filter</span>
          </button>
        </div>
        {/* 6 Grid Folders inspired by Kintsugi */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-8">
          {Object.entries(folderConfig).map(([key, folder]) => {
            const isActive = activeFolder === key;
            return (
              <div
                key={key}
                onClick={() => setActiveFolder(key)}
                className={`relative cursor-pointer select-none rounded-[16px] border p-5 pt-8 min-h-[140px] transition-all hover:translate-y-[-2px] ${
                  isActive
                    ? "bg-gradient-to-br from-[#5996f7] to-[#2563eb] text-white shadow-lg shadow-blue-500/10 border-transparent"
                    : "bg-white text-black border-gray-200/60 hover:border-gray-300 hover:shadow-sm"
                }`}
              >
                {/* Folder Top Tab */}
                <div
                  className={`absolute top-[-9px] left-4 h-2.5 w-16 rounded-t-md border-t border-x ${
                    isActive
                      ? "bg-[#5996f7] border-transparent"
                      : "bg-white border-gray-200/60"
                  }`}
                />
                
                {/* Peaking sheet animation layout */}
                {isActive && (
                  <div className="absolute top-[-6px] right-6 h-10 w-16 bg-white/10 rounded-sm transform rotate-6 border border-white/20 flex flex-col p-1 gap-0.5 overflow-hidden">
                    <div className="h-0.5 w-10 bg-white/30 rounded" />
                    <div className="h-0.5 w-8 bg-white/30 rounded" />
                    <div className="h-0.5 w-12 bg-white/20 rounded" />
                  </div>
                )}

                <div className="font-semibold text-[15px]">{folder.name}</div>
                <div className={`text-[12px] mt-1 ${isActive ? "text-white/80" : "text-gray-400"}`}>
                  {folder.count} {folder.count === 1 ? "item" : "items"}
                </div>
                <div className={`text-[11px] mt-6 font-mono ${isActive ? "text-white/60" : "text-gray-400"}`}>
                  {folder.size}
                </div>
              </div>
            );
          })}
        </div>

        {/* Dynamic Folder Items List */}
        <div className="flex-1 rounded-[16px] border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-4">
            <h3 className="font-bold text-[14px] text-black">Files in {selectedFolder.name}</h3>
            <span className="text-[11.5px] text-gray-400">{filteredItems.length} items found</span>
          </div>

          {activeFolder === "charts" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-4">
                <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Metric History
                </h4>
                <MetricHistoryChart data={metrics} />
              </div>
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-4">
                <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Valuation Signals
                </h4>
                <ValuationSignalChart data={signals} />
              </div>
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-4">
                <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Research Cost
                </h4>
                <ResearchCostChart data={costData} />
              </div>
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-4">
                <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Pipeline Progress
                </h4>
                <PipelineProgressChart data={stages} />
              </div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center py-12">
              <span className="text-2xl block mb-2">📭</span>
              <p className="text-gray-400 text-sm font-medium">No workspace assets matches this search query.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-xl border border-gray-100/60 bg-[#fbfcfd] px-4 py-3.5 hover:border-gray-200 hover:bg-gray-50/20 cursor-pointer transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400">
                      {item.type === "pdf" ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      ) : item.type === "xls" || item.type === "pptx" ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z" />
                        </svg>
                      ) : item.type === "run" ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                      )}
                    </div>
                    <div className="text-left">
                      <div className="text-[13px] font-semibold text-black">{item.name}</div>
                      <div className="text-[11.5px] text-gray-400 font-normal">{item.detail}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-gray-400 font-mono">{item.size}</span>
                    <span className="text-[10px] bg-gray-100 text-gray-500 font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider">
                      {item.type}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 2. Side Panel (Right Column) - Toggleable Info / Chat Assistant */}
      <div className="w-[380px] bg-white border-l border-[#eef2f6] flex flex-col shrink-0 z-20 shadow-sm overflow-hidden">
        {/* Switch Toggle Tab Headers */}
        <div className="flex border-b border-[#eef2f6]">
          <button
            onClick={() => setChatOpen(false)}
            className={`flex-1 text-center py-3.5 text-[11.5px] font-bold tracking-wider uppercase border-b-2 transition-all ${
              !chatOpen
                ? "border-black text-black"
                : "border-transparent text-gray-400 hover:text-black"
            }`}
          >
            Info
          </button>
          <button
            onClick={() => setChatOpen(true)}
            className={`flex-1 text-center py-3.5 text-[11.5px] font-bold tracking-wider uppercase border-b-2 transition-all ${
              chatOpen
                ? "border-black text-black"
                : "border-transparent text-gray-400 hover:text-black"
            }`}
          >
            Assistant Chat
          </button>
        </div>

        {/* Switch Body content */}
        {!chatOpen ? (
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
            {/* Header info */}
            <div>
              <div className="flex justify-between items-start mb-1">
                <h3 className="font-bold text-[16px] text-black">{selectedFolder.name}</h3>
                <button className="text-gray-400 hover:text-black transition-colors" title="Options">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z" />
                  </svg>
                </button>
              </div>
              <p className="text-[12.5px] text-gray-400 leading-normal">{selectedFolder.desc}</p>
            </div>

            {/* Storage Progress Bars */}
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-4 flex flex-col gap-2">
                <div className="flex justify-between items-center text-[12px]">
                  <span className="text-gray-400 font-medium">Documents</span>
                  <span className="font-bold text-black">48.5 GB</span>
                </div>
                {/* Custom Blue Progress Line */}
                <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${selectedFolder.progressDocs}%` }}
                  />
                </div>
              </div>

              <div className="rounded-xl border border-gray-100 bg-[#fbfcfd] p-4 flex flex-col gap-2">
                <div className="flex justify-between items-center text-[12px]">
                  <span className="text-gray-400 font-medium">Model Runs</span>
                  <span className="font-bold text-black">{runs.length} runs</span>
                </div>
                {/* Custom Red/Coral Progress Line */}
                <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-red-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${selectedFolder.progressRuns}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Properties table grid */}
            <div>
              <h4 className="font-bold text-[12.5px] text-black mb-3">Properties</h4>
              <div className="flex flex-col gap-2.5 font-sans text-[12px]">
                <div className="flex justify-between">
                  <span className="text-gray-400">Size</span>
                  <span className="font-semibold text-black">{selectedFolder.size}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Created</span>
                  <span className="font-semibold text-black">12/03/2026</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Last modification</span>
                  <span className="font-semibold text-black">
                    {runs.length > 0 ? new Date(runs[0].created_at).toLocaleDateString() : "06/12/2026"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Home Profile</span>
                  <span className="font-semibold text-black uppercase tracking-wider">{assetDetail.asset_kind}</span>
                </div>
              </div>
            </div>

            {/* Tag Pills */}
            <div>
              <h4 className="font-bold text-[12.5px] text-black mb-3">Tags</h4>
              <div className="flex flex-wrap gap-2 text-[11.5px] font-semibold">
                <span className="flex items-center gap-1.5 rounded-full bg-[#eff6ff] text-[#1d4ed8] px-3 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                  {assetDetail.asset_kind.toUpperCase()}
                </span>
                <span className="flex items-center gap-1.5 rounded-full bg-[#fcf2f2] text-[#c2410c] px-3 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#f97316]" />
                  HIGH CONVICTION
                </span>
                <span className="flex items-center gap-1.5 rounded-full bg-[#f0fdf4] text-[#15803d] px-3 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
                  {assetDetail.sector || "SECTOR"}
                </span>
              </div>
            </div>

            {/* Footer options */}
            <div className="mt-auto pt-6 border-t border-gray-100 flex flex-col gap-2 font-semibold text-[12px] text-gray-500">
              <button className="flex items-center gap-2.5 py-1.5 hover:text-black transition-colors text-left">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v2a2 2 0 01-2 2H7a2 2 0 01-2-2V5zm7 4v12m-3-3h6" />
                </svg>
                <span>Pinned items</span>
              </button>
              <button className="flex items-center gap-2.5 py-1.5 hover:text-black transition-colors text-left">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z" />
                </svg>
                <span>Activity stream</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Chat Messages Log */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {chatMessages.length === 0 ? (
                <div className="text-center py-12 flex flex-col items-center gap-3">
                  <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="text-gray-400 text-[12.5px] font-medium leading-normal max-w-[200px]">
                    Ask any question about this asset&apos;s research data context.
                  </p>
                  <div className="w-full mt-4 space-y-2 font-mono text-[12px]">
                    {[
                      "Summarize the thesis",
                      "What are the key risks?",
                      "Show valuation signals",
                    ].map((q) => (
                      <button
                        key={q}
                        onClick={() => setChatInput(q)}
                        className="block w-full text-left rounded-xl border border-gray-200 bg-white px-3 py-2 text-gray-600 hover:text-black hover:border-gray-300 transition-all shadow-sm"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                chatMessages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-[16px] px-3.5 py-2 text-[12.5px] leading-relaxed ${
                        msg.role === "user"
                          ? "bg-black text-white rounded-br-sm"
                          : "bg-gray-100 text-black rounded-bl-sm"
                      }`}
                    >
                      <pre className="whitespace-pre-wrap font-sans">
                        {msg.content}
                      </pre>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Chat Input Bar */}
            <div className="p-4 border-t border-[#eef2f6] bg-[#fafafa]">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleChat()}
                  placeholder="Ask about research..."
                  className="flex-1 rounded-xl border border-gray-200 px-3 py-1.5 text-[12px] bg-white focus:outline-none focus:border-blue-500 font-mono"
                />
                <button
                  onClick={handleChat}
                  className="rounded-xl bg-black px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-black/90 transition-all shadow-sm"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
