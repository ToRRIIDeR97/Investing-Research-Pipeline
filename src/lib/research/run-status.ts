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
  if (waitingStageKey === "research_plan" && status === "waiting_for_human") return "Needs plan approval";
  if (["completed", "approved"].includes(status)) return "Decided";
  // needs_more_work is a run the pipeline stopped (failed stage, quality gate or budget), not a wait on the reader.
  if (["failed", "cancelled", "needs_more_work"].includes(status)) return "Stopped";
  if (status === "waiting_for_human") return "Needs your decision";
  return "Researching";
}

/**
 * A company's status from its runs: a run waiting at the final review (waiting_for_human at human_review) means
 * Needs your decision even when a later run stopped; otherwise the latest run's word.
 */
export function companyStatusWord(runs: readonly { status: string; created_at: string | Date; waiting_stage_key?: string | null }[]): StatusWord {
  if (runs.some((r) => r.status === "waiting_for_human" && r.waiting_stage_key === "human_review")) return "Needs your decision";
  const latest = [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  return runStatusWord(latest?.status, latest?.waiting_stage_key);
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
