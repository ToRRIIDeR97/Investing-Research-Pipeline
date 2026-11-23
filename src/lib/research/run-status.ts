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
 * The review decisions that settle a run (review_decisions.status). needs_more_work is a reviewer's send-back, not a
 * decision: the run redrafts or waits again, so it changes nothing here.
 */
export const FINAL_DECISIONS: ReadonlySet<string> = new Set(["approved_for_tracking", "approved_for_position", "watchlist", "reject"]);
export const isFinalDecision = (decision: string | null | undefined) => decision != null && FINAL_DECISIONS.has(String(decision).toLowerCase());

/** Run statuses the pipeline ends without a report under review (needs_more_work: failed stage, quality gate or budget). */
export const STOPPED_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled", "needs_more_work"]);

/**
 * A run status as one of the words; unknown statuses read as Researching rather than leaking a raw code. A run that
 * waits at the plan gate (`waitingStageKey` "research_plan") needs plan approval, not the final decision. A run whose
 * latest review decision is final (`latestDecision`: approved, watchlist or reject) reads Decided.
 */
export function runStatusWord(status: string | null | undefined, waitingStageKey?: string | null, latestDecision?: string | null): StatusWord {
  if (!status) return "Not started";
  if (isFinalDecision(latestDecision)) return "Decided";
  if (waitingStageKey === "research_plan" && status === "waiting_for_human") return "Needs plan approval";
  if (["completed", "approved"].includes(status)) return "Decided";
  // needs_more_work is a run the pipeline stopped (failed stage, quality gate or budget), not a wait on the reader.
  if (STOPPED_STATUSES.has(status)) return "Stopped";
  if (status === "waiting_for_human") return "Needs your decision";
  return "Researching";
}

interface CompanyRun { status: string; created_at: string | Date; waiting_stage_key?: string | null; latest_decision?: string | null }

/**
 * A company's status from its runs: a run waiting at the final review (waiting_for_human at human_review, with no
 * final decision) means Needs your decision even when a later run stopped; otherwise the latest run's word.
 */
export function companyStatusWord(runs: readonly CompanyRun[]): StatusWord {
  if (runs.some((r) => r.status === "waiting_for_human" && r.waiting_stage_key === "human_review" && !isFinalDecision(r.latest_decision))) return "Needs your decision";
  const latest = [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  return runStatusWord(latest?.status, latest?.waiting_stage_key, latest?.latest_decision);
}

/** The Tag tone for a status word. */
export const statusTone = (word: string): StatusTone => TONE[word as StatusWord] ?? "neutral";

const GOOD_STATES = new Set(["completed", "complete", "pass", "success", "approved", "healthy", "met"]);
const BAD_STATES = new Set(["failed", "fail", "error", "cancelled", "canceled", "critical", "danger", "not_met"]);
const WAITING_STATES = new Set(["waiting_for_human", "running", "queued", "pending", "needs_more_work", "caution", "warn", "partially_met"]);

/** The Tag tone for a raw stage, task, job or check state on the operational screens (colour only on the dot). */
export function stateTone(state: string | null | undefined): StatusTone {
  const s = String(state ?? "").toLowerCase();
  if (GOOD_STATES.has(s)) return "good";
  if (BAD_STATES.has(s)) return "bad";
  if (WAITING_STATES.has(s)) return "waiting";
  return "neutral";
}

/** Each status word has its own filter key, so every asset counts under exactly one stage. */
export const STAGE_KEY: Record<StatusWord, string> = { "Not started": "idea", Researching: "running", "Needs your decision": "review", "Needs plan approval": "plan", Decided: "done", Completed: "done", Stopped: "stopped" };

/** Where an asset stands, from its latest run. A run of it in the review queue (`reviewing`) means Needs your decision. */
export function stageOf(asset: { id: string; latest_run?: { status: string; waiting_stage_key?: string | null; latest_decision?: string | null } | null }, reviewing?: ReadonlySet<string>): { key: string; label: StatusWord; tone: StatusTone } {
  const label: StatusWord = reviewing?.has(asset.id) ? "Needs your decision"
    : runStatusWord(asset.latest_run?.status, asset.latest_run?.waiting_stage_key, asset.latest_run?.latest_decision);
  return { key: STAGE_KEY[label], label, tone: statusTone(label) };
}
