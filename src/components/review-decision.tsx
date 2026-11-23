"use client";

import { useState, type ReactNode } from "react";
import { Activity, Eye, Lock, Undo2, X } from "lucide-react";
import { RUBRIC_DIMENSIONS, RUBRIC_LEVELS } from "@/lib/research/scoring/rubric";
import { NO_REVIEW, REVIEW_FAILED, type DecisionOptions, type ReviewChoice } from "@/lib/review/review-view";
import styles from "./review-decision.module.css";

export interface DecisionExtras { ack: boolean; conviction: string; whatWouldChangeMind: string; ratings: Record<string, string> }

const CONVICTIONS = ["high", "medium", "low", "speculative"];

/**
 * The final human decision: five option cards, an acknowledgement when approving over serious findings, an optional
 * note, and Record. An option the review route would refuse is marked aria-disabled with its reason; the route still
 * decides and its refusal is shown in `error`.
 */
export function ReviewDecision({ options, onSubmit, submitting = false, disabled = false, error = null }: {
  options: DecisionOptions;
  onSubmit: (choice: ReviewChoice, extras: DecisionExtras) => Promise<void>;
  submitting?: boolean;
  /** Nothing can be recorded yet (the report is still loading). */
  disabled?: boolean;
  error?: string | null;
}) {
  const [choice, setChoice] = useState<ReviewChoice | null>(null);
  const [ack, setAck] = useState(false);
  const [conviction, setConviction] = useState("");
  const [whatWouldChangeMind, setWhatWouldChangeMind] = useState("");
  const [ratings, setRatings] = useState<Record<string, string>>({});

  const noReview = options.position.reasons.includes(NO_REVIEW);
  const trackingReason = noReview ? NO_REVIEW : REVIEW_FAILED;
  const positionReason = options.position.reasons.length > 1 ? `${options.position.reasons[0]}, and ${options.position.reasons.length - 1} more` : options.position.reasons[0] ?? "";
  const cards: { key: ReviewChoice; title: string; note: string; icon: ReactNode; allowed: boolean }[] = [
    { key: "position", title: "Approve for a position", note: options.position.allowed ? "Ready to size a position" : positionReason, icon: <Lock size={16} />, allowed: options.position.allowed },
    { key: "tracking", title: "Approve for tracking", note: options.tracking.allowed ? "Follow it, no position yet" : trackingReason, icon: <Activity size={16} />, allowed: options.tracking.allowed },
    { key: "watch", title: "Watchlist", note: "Revisit later", icon: <Eye size={16} />, allowed: true },
    { key: "back", title: "Send back for more work", note: "The report is redrafted", icon: <Undo2 size={16} />, allowed: true },
    { key: "reject", title: "Reject", note: "Close it", icon: <X size={16} />, allowed: true },
  ];
  const approving = choice === "position" || choice === "tracking";
  const needsAck = approving && options.ackRequired;
  const busy = submitting || disabled;
  const ready = choice !== null && !busy && (!needsAck || ack);

  return <section className={styles.card} aria-labelledby="decision-title">
    <h2 id="decision-title">Record your decision</h2>
    <div className={styles.options} role="group" aria-label="Decision">
      {cards.map((card) => <button key={card.key} type="button" className={styles.option} aria-pressed={choice === card.key ? "true" : "false"}
        aria-disabled={card.allowed ? undefined : "true"} disabled={busy}
        onClick={() => { if (card.allowed) setChoice(card.key); }}>
        <span className={styles.icon} aria-hidden="true">{card.allowed ? card.icon : <Lock size={16} />}</span>
        <span className={styles.text}><strong>{card.title}</strong><span>{card.note}</span></span>
      </button>)}
    </div>
    {needsAck && <label className={styles.ack}><input type="checkbox" checked={ack} disabled={submitting} onChange={(event) => setAck(event.target.checked)} />
      <span>I&apos;ve read the <a href="#ai-review">serious findings</a> the AI review left open.</span></label>}
    <details className={styles.note}>
      <summary>Add a note</summary>
      <div className={styles.noteBody}>
        <label>Conviction<select value={conviction} disabled={submitting} onChange={(event) => setConviction(event.target.value)}>
          <option value="">Not set</option>{CONVICTIONS.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select></label>
        <label>What would change your mind?<textarea rows={3} value={whatWouldChangeMind} disabled={submitting} onChange={(event) => setWhatWouldChangeMind(event.target.value)} /></label>
        <fieldset>
          <legend>Depth ratings, 0 to 4</legend>
          <p>{RUBRIC_LEVELS.join(" · ")}</p>
          <div className={styles.ratings}>{RUBRIC_DIMENSIONS.map((d) => <label key={d.id} title={`3 = ${d.anchor3}`}>{d.label}
            <select value={ratings[d.id] ?? ""} disabled={submitting} onChange={(event) => setRatings({ ...ratings, [d.id]: event.target.value })}>
              <option value="">Unrated</option>{[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>)}</div>
        </fieldset>
      </div>
    </details>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button type="button" className={styles.record} disabled={!ready}
      onClick={() => { if (choice && ready) void onSubmit(choice, { ack, conviction, whatWouldChangeMind, ratings }); }}>{submitting ? "Saving…" : "Record decision"}</button>
  </section>;
}
