"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight, Search } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import { ResearchReport } from "@/components/research-report";
import type { ReportDocument } from "@/lib/research/reporting/report";

interface ReviewItem {
  run_id: string;
  asset_id: string;
  run_type: string;
  research_question: string | null;
  asset_name: string;
  asset_slug: string;
  asset_kind: string;
  priority: string | null;
}
const verdicts = [
  ["approved_for_position", "Approved for position"],
  ["approved_for_tracking", "Approved for tracking"],
  ["watchlist", "Watchlist"],
  ["needs_more_work", "Needs more work"],
  ["reject", "Reject"],
];
const emptyForm = { status: "approved_for_tracking", conviction: "", priority: "medium", watchlistReason: "", positionSizingNote: "", whatWouldChangeMind: "", openQuestions: "" };

export default function ReviewQueuePage() {
  return <Suspense fallback={<div className={ui.page} role="status">Loading reviews…</div>}><ReviewQueue /></Suspense>;
}

function ReviewQueue() {
  const requestedRunId = useSearchParams().get("run");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ReviewItem | null>(null);
  const [query, setQuery] = useState("");
  const [reviewForm, setReviewForm] = useState(emptyForm);
  const [reportDocument, setReportDocument] = useState<ReportDocument | null>(null);
  const [reportReady, setReportReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReportDocument(null); setReportReady(false);
    if (!selectedItem) return;
    fetch(`/api/research-runs/${selectedItem.run_id}/report`).then(async response => {
      if (!response.ok) throw new Error("Unable to load the report for review.");
      const report = await response.json();
      if (cancelled) return;
      setReportDocument(report.report_document || null);
      const required = report.artifacts?.some((a: any) => a.type === "research_plan" && a.content_json?.report_standard);
      setReportReady(!required || Boolean(report.report_document));
      if (required && !report.report_document) setSubmitError("The report is not ready for review yet.");
    }).catch(error => { if (!cancelled) setSubmitError(String(error.message)); });
    return () => { cancelled = true; };
  }, [selectedItem?.run_id]);

  function selectItem(item: ReviewItem | null) {
    setSelectedItem(item);
    setReviewForm(emptyForm);
    setSubmitError("");
    setSaved(false);
  }
  async function fetchQueue(selectRequested = false) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/review/queue");
      if (!res.ok) throw new Error();
      const data = await res.json();
      const queue: ReviewItem[] = Array.isArray(data) ? data : [];
      setItems(queue);
      if (selectRequested) selectItem(queue.find((item) => item.run_id === requestedRunId) ?? null);
    } catch { setError("Unable to load reviews."); }
    finally { setLoading(false); }
  }
  useEffect(() => { fetchQueue(true); }, [requestedRunId]);

  async function handleSubmitReview(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedItem || submitting || !reportReady) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`/api/research-runs/${selectedItem.run_id}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reviewForm, assetId: selectedItem.asset_id, reviewedBy: "user", reportHash: reportDocument?.content_hash }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(typeof body.error === "string" ? body.error : "Unable to save the decision.");
      }
      setSelectedItem(null);
      setSaved(true);
      await fetchQueue();
    } catch (error) { setSubmitError(error instanceof Error ? error.message : "Unable to save the decision."); }
    finally { setSubmitting(false); }
  }
  const visible = items.filter((item) => [item.asset_name, item.asset_slug, item.asset_kind, item.run_type, item.research_question || "", item.priority || ""].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));

  return <div className={`${ui.page} ${selectedItem ? ui.withBack : ""}`}>
    {selectedItem ? <>
      <button className={ui.back} onClick={() => selectItem(null)} disabled={submitting}><ArrowLeft size={17} />Reviews</button>
      <header className={ui.heading}><h1>{selectedItem.asset_name}</h1><span className={ui.status} data-status="waiting_for_human">Review pending</span></header>
      {selectedItem.research_question && <details className="mb-6 text-sm text-[#515d70]"><summary>Research question</summary><p className="mt-4 leading-7">{selectedItem.research_question}</p></details>}
      <Link href={`/assets/${selectedItem.asset_id}/view?run=${selectedItem.run_id}`} className={ui.textLink}>Read research<ArrowUpRight size={16} /></Link>
      {reportDocument && <details className={ui.section} open><summary>Report under review</summary><ResearchReport document={reportDocument} /></details>}
      <form onSubmit={handleSubmitReview}>
        <section className={ui.section}>
          <div className={ui.sectionHead}><h2>Your decision</h2></div>
          <div className={ui.form}>
            <label className={ui.field}>Verdict<select value={reviewForm.status} disabled={submitting} onChange={(event) => setReviewForm({ ...reviewForm, status: event.target.value })}>{verdicts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className={ui.formGrid}>
              <label className={ui.field}>Conviction<select value={reviewForm.conviction} disabled={submitting} onChange={(event) => setReviewForm({ ...reviewForm, conviction: event.target.value })}><option value="">Unset</option>{["high", "medium", "low", "speculative"].map((value) => <option value={value} key={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
              <label className={ui.field}>Priority<select value={reviewForm.priority} disabled={submitting} onChange={(event) => setReviewForm({ ...reviewForm, priority: event.target.value })}>{["high", "medium", "low"].map((value) => <option value={value} key={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
            </div>
            <label className={ui.field}>What would change your mind?<textarea rows={3} value={reviewForm.whatWouldChangeMind} disabled={submitting} onChange={(event) => setReviewForm({ ...reviewForm, whatWouldChangeMind: event.target.value })} /></label>
          </div>
        </section>
        <details className={ui.section}><summary>Additional notes</summary><div className={`${ui.form} ${ui.sectionBody}`}>
          {[["watchlistReason", "Watchlist reason"], ["positionSizingNote", "Position sizing"], ["openQuestions", "Open questions"]].map(([key, label]) => <label key={key} className={ui.field}>{label}<textarea rows={3} disabled={submitting} value={reviewForm[key as keyof typeof reviewForm]} onChange={(event) => setReviewForm({ ...reviewForm, [key]: event.target.value })} /></label>)}
        </div></details>
        {submitError && <p className={ui.error} role="alert">{submitError}</p>}
        <footer className={ui.actions}><button type="button" className={ui.textLink} disabled={submitting} onClick={() => selectItem(null)}>Cancel</button><button className={ui.primary} type="submit" disabled={submitting || !reportReady}>{submitting ? "Saving…" : "Submit decision"}</button></footer>
      </form>
    </> : <>
      <header className={ui.heading}><h1>Reviews</h1><span className={ui.muted}>{loading ? "" : `${items.length} pending`}</span></header>
      {saved && <p className={ui.notice} role="status">Decision saved.</p>}
      <div className={ui.search}><Search size={19} aria-hidden="true" /><input type="search" aria-label="Search reviews" placeholder="Search reviews" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      {loading ? <p className={ui.empty} role="status">Loading reviews…</p> : error ? <p className={ui.error} role="alert">{error}<button onClick={() => fetchQueue(true)}>Try again</button></p> : <>
        {requestedRunId && !items.some((item) => item.run_id === requestedRunId) && !saved && <p className={ui.notice}>This run is no longer awaiting review.</p>}
        {visible.map((item) => <button key={item.run_id} className={ui.row} onClick={() => selectItem(item)}><div><div className={ui.rowTitle}>{item.asset_name}</div><div className={ui.rowMeta}>{item.run_type.replace(/_/g, " ")} · {item.run_id.slice(0, 8)}</div></div><ArrowRight size={18} /></button>)}
        {!visible.length && <p className={ui.empty}>{query ? "No reviews match your search." : "No reviews waiting."}</p>}
      </>}
    </>}
  </div>;
}
