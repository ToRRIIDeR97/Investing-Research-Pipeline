"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  ClipboardCheck,
  FileCheck2,
  Search,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";

interface ReviewItem {
  run_id: string;
  asset_id: string;
  run_type: string;
  run_status: string;
  research_question: string | null;
  completed_at: string | null;
  asset_name: string;
  asset_slug: string;
  asset_kind: string;
  review_id: string | null;
  review_status: string | null;
  conviction: string | null;
  priority: string | null;
  reviewed_at: string | null;
}

const verdicts = [
  ["approved_for_position", "Approved for Position"],
  ["approved_for_tracking", "Approved for Tracking"],
  ["watchlist", "Watchlist"],
  ["needs_more_work", "Needs More Work"],
  ["reject", "Reject"],
];

export default function ReviewQueuePage() {
  const [requestedRunId, setRequestedRunId] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<ReviewItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reviewForm, setReviewForm] = useState({
    status: "approved_for_tracking",
    conviction: "",
    priority: "medium",
    watchlistReason: "",
    positionSizingNote: "",
    whatWouldChangeMind: "",
    openQuestions: "",
  });

  useEffect(() => {
    fetchQueue();
    setRequestedRunId(new URLSearchParams(window.location.search).get("run"));
  }, []);

  useEffect(() => {
    if (!requestedRunId || loading) return;
    setSelectedItem(items.find((item) => item.run_id === requestedRunId) || null);
  }, [items, loading, requestedRunId]);

  async function fetchQueue() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/review/queue");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to load the review queue");
      setItems(Array.isArray(data) ? data : []);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load the review queue");
      console.error("Failed to fetch review queue:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitReview() {
    if (!selectedItem) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/research-runs/${selectedItem.run_id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...reviewForm,
          assetId: selectedItem.asset_id,
          reviewedBy: "user",
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Unable to submit this decision");
      setSelectedItem(null);
      await fetchQueue();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to submit this decision");
      console.error("Failed to submit review:", error);
    } finally {
      setSubmitting(false);
    }
  }

  const filteredItems = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return items;

    return items.filter((item) =>
      [
        item.asset_name,
        item.asset_slug,
        item.asset_kind,
        item.run_type,
        item.research_question || "",
        item.priority || "",
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [items, searchQuery]);

  return (
    <div className="flex min-h-screen overflow-hidden bg-[#f4f7fa]">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-5 py-6 lg:px-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-gray-400">
              <span>Workspace</span>
              <span>/</span>
              <span className="text-gray-600">Review Gates</span>
            </div>
            <h1 className="text-[26px] font-bold tracking-tight text-black">Review queue</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray-500">
              Resolve completed research runs with explicit conviction, sizing notes, and changed-mind criteria.
            </p>
          </div>

          <div className="font-mono text-[11px] text-gray-400" aria-live="polite">{loading ? "Loading queue…" : `${filteredItems.length} visible · ${items.length} open`}</div>
        </div>

        <div className="mt-5 rounded-md border border-gray-200 bg-white p-3 shadow-sm">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search asset, run type, research question, or priority"
              aria-label="Search review queue"
              className="h-10 w-full rounded-md border border-gray-200 bg-[#fbfcfd] pl-10 pr-3 font-mono text-[12px] outline-none transition-colors focus:border-gray-300"
            />
          </div>
        </div>

        <div className="mt-5 min-h-0 flex-1">
          {loading ? (
            <div className="rounded-md border border-gray-200 bg-white py-16 text-center font-mono text-[12px] text-gray-400 shadow-sm">
              Loading review gates...
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-red-200 bg-red-50 px-5 py-8 text-center text-sm text-red-700 shadow-sm" role="alert">
              <span>{error}</span>
              <button type="button" onClick={fetchQueue} className="inline-flex h-8 items-center gap-2 rounded-md border border-red-200 bg-white px-3 text-[11px] font-bold text-red-700 hover:border-red-300">Retry</button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="rounded-md border border-gray-200 bg-white py-16 text-center shadow-sm">
              <FileCheck2 className="mx-auto mb-3 text-gray-300" size={34} />
              <p className="text-[14px] font-bold text-gray-600">All review gates are clear</p>
              <p className="mt-1 text-[12px] text-gray-400">Completed runs will appear here when they need a decision.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
              {filteredItems.map((item) => {
                const selected = selectedItem?.run_id === item.run_id;
                return (
                  <div
                    key={item.run_id}
                    className={[
                      "border-b border-gray-100 p-3.5 text-left transition-colors last:border-0 hover:bg-[#fbfcfd]",
                      selected ? "bg-[#fbfcfd] ring-1 ring-inset ring-black" : "",
                    ].join(" ")}
                  >
                    <button type="button" onClick={() => { setSelectedItem(item); setSubmitError(null); }} className="w-full text-left" aria-expanded={selected}>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="truncate text-[14px] font-bold text-black">{item.asset_name}</h2>
                            <span className="rounded-full border border-gray-200 bg-[#fbfcfd] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                              {item.asset_kind.replace(/_asset/g, "")}
                            </span>
                            {item.priority && (
                              <span className="rounded-full bg-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                                {item.priority}
                              </span>
                            )}
                          </div>
                          <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-gray-500">
                            <span className="mr-2 font-mono text-[11px] font-bold uppercase tracking-wider text-black">
                              {item.run_type.replace(/_/g, " ")}
                            </span>
                            {item.research_question || "Default pipeline research run"}
                          </p>
                        </div>
                        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gray-200 bg-[#fbfcfd] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                          needs review
                        </span>
                      </div>
                    </button>
                    <Link href={`/assets/${item.asset_id}/research/general?run=${item.run_id}`} className="mt-3 inline-flex rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-bold text-gray-700 hover:border-gray-300 hover:text-black">
                      View research preview
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selectedItem && <button type="button" onClick={() => setSelectedItem(null)} className="fixed inset-0 z-30 bg-black/20 lg:hidden" aria-label="Close decision desk" />}
      <aside className={[selectedItem ? "fixed inset-y-0 right-0 z-40 flex w-full max-w-[400px]" : "hidden", "shrink-0 flex-col border-l border-[#e8edf2] bg-white shadow-[-8px_0_30px_rgba(17,24,39,0.03)] lg:static lg:flex lg:w-[400px]"].join(" ")} aria-label="Decision desk">
        {selectedItem ? (
          <>
            <div className="border-b border-gray-100 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">
                    <ClipboardCheck size={14} />
                    Decision desk
                  </div>
                  <h2 className="text-[17px] font-bold text-black">{selectedItem.asset_name}</h2>
                  <p className="mt-1 text-[12px] leading-5 text-gray-500">
                    Review the automated research first, then record the investment decision and the conditions that would invalidate it.
                  </p>
                  <Link href={`/assets/${selectedItem.asset_id}/research/general?run=${selectedItem.run_id}`} className="mt-3 inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-2 text-[11px] font-bold text-gray-700 transition-colors hover:border-gray-300 hover:text-black">
                    View research preview
                  </Link>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedItem(null)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-50 hover:text-black"
                  title="Close panel"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-400">Review Verdict</span>
                  <select
                    value={reviewForm.status}
                    onChange={(event) => setReviewForm({ ...reviewForm, status: event.target.value })}
                    className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 font-mono text-[12px] outline-none"
                  >
                    {verdicts.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-400">Conviction</span>
                    <select
                      value={reviewForm.conviction}
                      onChange={(event) => setReviewForm({ ...reviewForm, conviction: event.target.value })}
                      className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 font-mono text-[12px] outline-none"
                    >
                      <option value="">Unset</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                      <option value="speculative">Speculative</option>
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-400">Priority</span>
                    <select
                      value={reviewForm.priority}
                      onChange={(event) => setReviewForm({ ...reviewForm, priority: event.target.value })}
                      className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 font-mono text-[12px] outline-none"
                    >
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </label>
                </div>

                {[
                  ["watchlistReason", "Watchlist Reason", "Why this belongs on watchlist, or why it does not."],
                  ["positionSizingNote", "Position Sizing Note", "Allocation range, max position, or sizing constraints."],
                  ["whatWouldChangeMind", "What Would Change Mind", "Evidence that would alter or invalidate the thesis."],
                  ["openQuestions", "Open Questions", "Questions to route into the next run."],
                ].map(([key, label, placeholder]) => (
                  <label key={key} className="block">
                    <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-400">{label}</span>
                    <textarea
                      value={reviewForm[key as keyof typeof reviewForm]}
                      onChange={(event) => setReviewForm({ ...reviewForm, [key]: event.target.value })}
                      placeholder={placeholder}
                      rows={3}
                      className="w-full resize-none rounded-md border border-gray-200 bg-white p-3 font-mono text-[12px] leading-5 outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="border-t border-gray-100 p-5">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSubmitReview}
                  disabled={submitting}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-black px-4 text-[12px] font-bold text-white transition-colors hover:bg-black/90"
                >
                  <Send size={14} />
                  {submitting ? "Submitting…" : "Submit Decision"}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedItem(null)}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-gray-200 bg-white px-4 text-[12px] font-bold text-gray-600 transition-colors hover:border-gray-300 hover:text-black"
                >
                  Cancel
                </button>
              </div>
              {submitError && <p className="mt-3 text-[11px] leading-4 text-red-600" role="alert">{submitError}</p>}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <ShieldCheck className="mb-3 text-gray-300" size={36} />
            <h2 className="text-[15px] font-bold text-black">Select a review gate</h2>
            <p className="mt-2 max-w-[240px] text-[12px] leading-5 text-gray-400">
              Choose a completed run to submit conviction, priority, sizing notes, and open questions.
            </p>
            <div className="mt-5 flex items-center gap-2 rounded-full border border-gray-200 bg-[#fbfcfd] px-3 py-1.5 text-[11px] font-bold text-gray-500">
              <Check size={13} />
              Evidence-linked decisions only
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
