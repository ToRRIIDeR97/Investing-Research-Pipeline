"use client";
// The final human gate, on the memo. Reject, watchlist and "needs more work" are recorded here through the same
// review endpoint as the Reviews page. Approval opens the full review form, where the reviewer reads and acknowledges
// open review findings and rates the report: the gate stays explicit and unchanged.
import { useState } from "react";
import Link from "next/link";
import styles from "./memo.module.css";

type Choice = "reject" | "watchlist" | "needs_more_work";
const CHOICES: [Choice, string][] = [["reject", "Reject"], ["watchlist", "Watchlist"], ["needs_more_work", "Needs more work"]];

export function DecisionPanel({ runId, assetId, reportHash, onDecided }: { runId: string; assetId: string; reportHash: string | null; onDecided: () => void }) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [conviction, setConviction] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!choice || saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/research-runs/${runId}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: choice, assetId, reviewedBy: "user", reportHash: reportHash ?? undefined,
          conviction: conviction || undefined, whatWouldChangeMind: note.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : typeof body.error?.message === "string" ? body.error.message : "Unable to save the decision.");
      }
      setDone(CHOICES.find(([key]) => key === choice)?.[1] ?? choice);
      onDecided();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the decision.");
    } finally {
      setSaving(false);
    }
  }

  if (done) return <div className={styles.decision} role="status"><p className={styles.decisionDone}>Decision recorded: {done}.</p></div>;
  return <form className={styles.decision} onSubmit={submit} aria-label="Your decision">
    <strong>Your decision</strong>
    {CHOICES.map(([key, label]) => <button key={key} type="button" className={styles.choice} aria-pressed={choice === key} onClick={() => setChoice(choice === key ? null : key)}>{label}</button>)}
    <Link className={styles.choice} href={`/review?run=${encodeURIComponent(runId)}`} style={{ display: "inline-flex", alignItems: "center" }}>Approve…</Link>
    {choice && <div className={styles.decisionForm}>
      <label>Conviction (optional)
        <select value={conviction} onChange={(event) => setConviction(event.target.value)}>
          <option value="">Not set</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
      </label>
      <label>What would change your mind? (optional)
        <textarea rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div><button type="submit" className={styles.choice} aria-pressed="true" disabled={saving}>{saving ? "Saving…" : `Record "${CHOICES.find(([key]) => key === choice)?.[1]}"`}</button></div>
    </div>}
    {error && <p className={styles.decisionError} role="alert">{error}</p>}
    <p className={styles.decisionHint}>The research doesn&apos;t decide; you do. Approving opens the full review form, where open review findings are read and acknowledged.</p>
  </form>;
}
