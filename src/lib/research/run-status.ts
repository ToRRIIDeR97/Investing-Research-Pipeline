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

/**
 * A run status as one of the words; unknown statuses read as Researching rather than leaking a raw code. A run that
 * waits at the plan gate (`waitingStageKey` "research_plan") needs plan approval, not the final decision.
 */
export function runStatusWord(status: string | null | undefined, waitingStageKey?: string | null): StatusWord {
  if (!status) return "Not started";
  if (waitingStageKey === "research_plan" && ["waiting_for_human", "needs_more_work"].includes(status)) return "Needs plan approval";
  if (["completed", "approved"].includes(status)) return "Decided";
  if (["failed", "cancelled"].includes(status)) return "Stopped";
  if (["waiting_for_human", "needs_more_work"].includes(status)) return "Needs your decision";
  return "Researching";
}

/** The Tag tone for a status word. */
export const statusTone = (word: string): StatusTone => TONE[word as StatusWord] ?? "neutral";

/** Each status word has its own filter key, so every asset counts under exactly one stage. */
export const STAGE_KEY: Record<StatusWord, string> = { "Not started": "idea", Researching: "running", "Needs your decision": "review", "Needs plan approval": "plan", Decided: "done", Completed: "done", Stopped: "stopped" };

/** Where an asset stands, from its latest run. A run of it in the review queue (`reviewing`) means Needs your decision. */
export function stageOf(asset: { id: string; latest_run?: { status: string; waiting_stage_key?: string | null } | null }, reviewing?: ReadonlySet<string>): { key: string; label: StatusWord; tone: StatusTone } {
  const label: StatusWord = reviewing?.has(asset.id) ? "Needs your decision" : runStatusWord(asset.latest_run?.status, asset.latest_run?.waiting_stage_key);
  return { key: STAGE_KEY[label], label, tone: statusTone(label) };
}
