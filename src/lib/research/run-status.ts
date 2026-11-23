/**
 * The one run-status vocabulary of the app (consumer remaster), shared by the asset hero, the asset cards and rows,
 * Home and the Research list. Pure and client-safe.
 */

export type StatusWord = "Needs your decision" | "Needs plan approval" | "Researching" | "Decided" | "Completed" | "Stopped" | "Not started";
export type StatusTone = "neutral" | "waiting" | "good" | "bad";

const TONE: Record<StatusWord, StatusTone> = {
  "Needs your decision": "waiting", "Needs plan approval": "waiting", Researching: "neutral",
  Decided: "good", Completed: "good", Stopped: "bad", "Not started": "neutral",
};

/** A run status as one of the words; unknown statuses read as Researching rather than leaking a raw code. */
export function runStatusWord(status: string | null | undefined): StatusWord {
  if (!status) return "Not started";
  if (["completed", "approved"].includes(status)) return "Decided";
  if (["failed", "cancelled"].includes(status)) return "Stopped";
  if (["waiting_for_human", "needs_more_work"].includes(status)) return "Needs your decision";
  return "Researching";
}

/** The Tag tone for a status word. */
export const statusTone = (word: string): StatusTone => TONE[word as StatusWord] ?? "neutral";
