"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Lock } from "lucide-react";
import ui from "@/components/research-ui.module.css";
import styles from "./review.module.css";
import { CompanyLogo } from "@/components/company/company";
import { Card, Tag, type TagTone } from "@/components/ui/primitives";
import { FindingsDonut, ScenarioPicker, ValueMeter, type CaseKey, type FindingsGroup } from "@/components/interactive";
import { ReviewFindings } from "@/components/review-findings";
import { ReviewDecision, type DecisionExtras } from "@/components/review-decision";
import { reviewGate } from "@/lib/research/reporting/depth";
import { verdictLine, type ResearchMemo } from "@/lib/research/reporting/research-memo";
import type { ReportDocument } from "@/lib/research/reporting/report";
import { currentReviews, reviewCount } from "@/lib/review/queue-rules";
import type { ReviewQueueItem, ReviewSummary } from "@/lib/review/review-queue";
import { decisionOptions, groupFindingsByChapter, refusalWords, reviewBody, reviewOutcomeLabel, withReportCheck, type ReviewChoice } from "@/lib/review/review-view";
import { formatGap } from "@/lib/ui/chart-math";
import { InlineLoading, PageLoading } from "@/components/ui/loading";

type Row = Record<string, any>;

export default function ReviewsPage() {
  return <Suspense fallback={<div className={ui.page}><PageLoading shape="list" label="Loading reviews" /></div>}><Reviews /></Suspense>;
}

/** The AI review's outcome in words, from the summary's gate: its actual verdict, since the verdict is advisory. */
function reviewOutcome(review: ReviewSummary["review"] | null | undefined): [string, TagTone] {
  const tone: TagTone = !review ? "neutral" : review.positionable ? "good" : review.trackable ? "waiting" : "bad";
  return [reviewOutcomeLabel(review), tone];
}

/** The slug shown as a ticker only for equities; other kinds have no ticker to show. */
const ticker = (item: { asset_kind: string; asset_slug: string }) => item.asset_kind === "equity" ? item.asset_slug.toUpperCase() : null;

async function fetchQueue(): Promise<ReviewQueueItem[]> {
  const res = await fetch("/api/review/queue");
  if (!res.ok) throw new Error("queue");
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function Reviews() {
  const runId = useSearchParams().get("run");
  const router = useRouter();
  const [items, setItems] = useState<ReviewQueueItem[] | null>(null);
  const [error, setError] = useState("");
  const [decided, setDecided] = useState<string | null>(null);

  const load = useCallback(() => fetchQueue().then((data) => { setError(""); setItems(data); }, () => setError("The review queue couldn't be loaded.")), []);
  useEffect(() => { void load(); }, [load]);

  if (runId) {
    const item = items?.find((i) => i.run_id === runId);
    if (items && !item) return <div className={`${ui.page} ${ui.withBack}`}>
      <Link href="/review" className={ui.back}><ArrowLeft size={14} />Reviews</Link>
      <p className={ui.banner}>This run isn&apos;t waiting for a decision any more.</p>
    </div>;
    if (!item) return <div className={ui.page}>{error ? <p className={ui.error} role="alert">{error}</p> : <PageLoading shape="report" label="Loading the review" />}</div>;
    return <ReviewRun key={item.run_id} item={item} onDecided={(message) => { setDecided(message); void load(); router.push("/review"); }} />;
  }

  const current = items ? currentReviews(items) : [];
  return <div className={ui.page}>
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Reviews</h1>{items && reviewCount(items) > 0 && <Tag tone="waiting">{reviewCount(items)} waiting</Tag>}</div></header>
    {decided && <p className={ui.banner} role="status">{decided}</p>}
    {error ? <p className={ui.error} role="alert">{error}<button type="button" onClick={() => void load()}>Try again</button></p>
      : !items ? <PageLoading shape="list" label="Loading reviews" />
      : !current.length ? <Card><p className={styles.empty}>No reviews waiting.</p></Card>
      : <div className={styles.queue}>{current.map((item) => {
        const s = item.summary;
        const [outcome, tone] = reviewOutcome(s?.review);
        const older = items.filter((other) => other.replaced_by === item.run_id).length;
        return <section key={item.run_id} className={styles.queueCard} aria-label={item.asset_name}>
          <div className={styles.who}>
            <CompanyLogo subject={{ asset_id: item.asset_id }} name={item.asset_name} size={44} />
            <div><h2>{item.asset_name}</h2>{(ticker(item) || older > 0) && <span>{[ticker(item), older ? `replaces ${older} older ${older === 1 ? "run" : "runs"}` : null].filter(Boolean).join(" · ")}</span>}</div>
          </div>
          <div className={styles.stat}><strong data-tone={s?.gap == null ? undefined : s.gap < 0 ? "bad" : "good"}>{formatGap(s?.gap ?? null)}</strong><span>vs price</span></div>
          <div className={styles.outcome}><Tag tone={tone}>{outcome}</Tag></div>
          <Link href={`/review?run=${item.run_id}`} className={ui.primary} aria-label={`Open ${item.asset_name} review`}>Open</Link>
        </section>;
      })}</div>}
  </div>;
}

interface LoadedReport {
  document: ReportDocument | null; memo: ResearchMemo | null; review: Row | null;
  /** The run needs a report and the loaded one is not a validated or accepted version, so the route would refuse it. */
  unchecked: boolean;
}

const CHECKED_REPORT = new Set(["validated", "accepted"]);

/** Serious findings by chapter for the donut: the biggest four, the rest folded into "N more". */
function donutGroups(review: Row | null, sections: { id: string; title: string }[]): FindingsGroup[] {
  const groups = groupFindingsByChapter(review, sections).filter((g) => g.findings.length).sort((a, b) => b.serious - a.serious);
  const rows = groups.map((g) => ({ title: g.title, serious: g.serious, counts: g.counts as Record<string, number> }));
  if (rows.length <= 5) return rows;
  const rest = rows.slice(4);
  const counts: Record<string, number> = {};
  for (const r of rest) for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + (v ?? 0);
  return [...rows.slice(0, 4), { title: `${rest.length} more`, serious: rest.reduce((n, r) => n + r.serious, 0), counts }];
}

function ReviewRun({ item, onDecided }: { item: ReviewQueueItem; onDecided: (message: string) => void }) {
  const [report, setReport] = useState<LoadedReport | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<CaseKey>("base");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/research-runs/${item.run_id}/report`).then(async (res) => {
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (cancelled) return;
      const document: ReportDocument | null = data.report_document ?? null;
      const hash = document?.content_hash;
      const artifacts: Row[] = Array.isArray(data.artifacts) ? data.artifacts : [];
      const review = artifacts.find((a) => a.type === "report_review" && hash && a.content_json?.report_hash === hash)?.content_json ?? null;
      // Like the route (getReportState): a run whose plan sets a report standard is decided on its newest validated or accepted report.
      const required = artifacts.some((a) => a.type === "research_plan" && a.content_json?.report_standard);
      const status = String(artifacts.find((a) => a.type === "report_document")?.status ?? "");
      setReport({ document, memo: data.memo ?? null, review, unchecked: required && (!document || !CHECKED_REPORT.has(status)) });
    }).catch(() => { if (!cancelled) setLoadError("The report couldn't be loaded."); });
    return () => { cancelled = true; };
  }, [item.run_id]);

  const document = report?.document ?? null;
  const gate = report?.review ? reviewGate(report.review) : null;
  // The gate is worked out from the report being decided on, the same way the review route works it out.
  const options = withReportCheck(decisionOptions(report ? {
    conclusion_status: document?.conclusion_status ?? null,
    review: gate ? { verdict: gate.verdict == null ? null : String(gate.verdict), open_severe: gate.open_severe, blocking: gate.blocking, trackable: gate.trackable, positionable: gate.positionable } : null,
  } : null), Boolean(report?.unchecked));
  const sections = (document?.sections ?? []).map((s: Row) => ({ id: String(s.id ?? ""), title: String(s.title ?? s.id ?? "") }));
  const memo = report?.memo ?? null;
  const v = memo?.verdict;
  const currency = memo?.currency ?? item.summary?.currency ?? "USD";
  const price = v?.price ?? item.summary?.price ?? null;
  const values = v?.valuationComplete ? v.values : { bear: null, base: item.summary?.value ?? null, bull: null };
  const [outcome, tone] = reviewOutcome(report ? (gate ? { verdict: gate.verdict == null ? null : String(gate.verdict), open_severe: gate.open_severe, blocking: gate.blocking, trackable: gate.trackable, positionable: gate.positionable } : null) : item.summary?.review);

  async function submit(choice: ReviewChoice, extras: DecisionExtras) {
    // Watchlist and reject need no report; approving or sending back must name the report that was read.
    if (!document && choice !== "watch" && choice !== "reject") { setSubmitError(refusalWords("REPORT_NOT_READY")); return; }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const ratings = Object.fromEntries(Object.entries(extras.ratings).filter(([, value]) => value !== ""));
      const res = await fetch(`/api/research-runs/${item.run_id}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reviewBody(choice, { ack: extras.ack, reportHash: document?.content_hash ?? null }), reviewedBy: "user",
          ...(extras.conviction ? { conviction: extras.conviction } : {}), ...(extras.whatWouldChangeMind.trim() ? { whatWouldChangeMind: extras.whatWouldChangeMind.trim() } : {}),
          ...(Object.keys(ratings).length ? { rubricRatings: ratings } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSubmitError(refusalWords(body?.code, body?.error, { reportUnchecked: Boolean(report?.unchecked) }));
        return;
      }
      onDecided(choice === "back" ? `${item.asset_name} is sent back for more work.` : `Decision recorded for ${item.asset_name}.`);
    } catch { setSubmitError(refusalWords(null)); }
    finally { setSubmitting(false); }
  }

  return <div className={`${ui.page} ${ui.withBack}`}>
    <Link href="/review" className={ui.back}><ArrowLeft size={14} />Reviews</Link>
    <header className={styles.hero}>
      <div className={styles.who}>
        <CompanyLogo subject={{ asset_id: item.asset_id }} name={item.asset_name} size={56} />
        <div><h1>{item.asset_name}</h1>
          <p className={styles.meta}>{ticker(item) && <span>{ticker(item)}</span>}{item.replaced_by ? <Tag tone="neutral">Replaced by a newer run</Tag> : <Tag tone="waiting">Needs your decision</Tag>}</p></div>
      </div>
      <Link href={`/assets/${item.asset_id}/view?view=memo&run=${item.run_id}`} className={ui.secondary}>Open full report<ArrowUpRight size={14} /></Link>
    </header>
    {loadError && <p className={ui.error} role="alert">{loadError}</p>}
    <div className={styles.layout}>
      <div className={styles.main}>
        <Card title="What it's worth">
          {!report && !loadError ? <InlineLoading label="Loading the valuation" lines={3} />
            : v && !v.valuationComplete ? <p className={styles.empty}>{v.withheldReason ?? "The valuation was withheld."}</p>
            : <>
              <ValueMeter price={price} values={values} selected={values[selected] == null ? "base" : selected} currency={currency} />
              {values.bear != null && values.bull != null && <ScenarioPicker values={values} price={price} selected={selected} onSelect={setSelected} currency={currency} />}
              {memo && <p className={styles.note}>{verdictLine(memo)}</p>}
            </>}
        </Card>

        <section id="ai-review" aria-labelledby="ai-review-title" className={styles.cardSection}>
          <div className={styles.cardHead}><h2 id="ai-review-title">AI review</h2><Tag tone={tone}>{outcome}</Tag></div>
          {report ? <>
            {report.review && <FindingsDonut groups={donutGroups(report.review, sections)} />}
            {!options.position.allowed && <div className={styles.blocked} role="note">
              <h3><Lock size={14} aria-hidden="true" />Why it&apos;s blocked</h3>
              <ul>{options.position.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>}
            <ReviewFindings review={report.review} sections={sections} />
          </> : !loadError && <InlineLoading label="Loading the AI review" lines={3} />}
        </section>

        <Card title="The report says">
          {memo?.verdict.summary ? <blockquote className={styles.quote}>“{memo.verdict.summary}”</blockquote>
            : report ? <p className={styles.empty}>The report gives no conclusion to quote.</p> : <InlineLoading label="Loading the report" />}
          {memo?.otherSide && <div className={styles.otherSide}><h3>The other side</h3><p>{memo.otherSide}</p></div>}
        </Card>
      </div>
      <aside className={styles.side}>
        <ReviewDecision options={options} onSubmit={submit} submitting={submitting} disabled={!report} error={submitError} />
      </aside>
    </div>
  </div>;
}
