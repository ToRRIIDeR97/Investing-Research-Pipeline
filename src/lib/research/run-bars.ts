/**
 * A company's research runs as RunsBars input (src/components/interactive/runs-bars.tsx): oldest first, a short date
 * label, the outcome in plain words and the run's real cost. Pure; dates are read in UTC so the server and the
 * browser label a run the same way.
 */

export interface RunRow {
  id: string; created_at: string | Date; status: string; actual_cost_usd?: unknown; budget_limit_usd?: unknown;
  /** The stage the run waits at for a person (GET /api/assets/[id]/research-runs), e.g. "research_plan" or "human_review". */
  waiting_stage_key?: string | null;
}
export interface RunBarItem { id: string; label: string; outcome: string; cost: number; current: boolean }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Statuses that wait on a person; unless the run waits at the plan gate, that person owes the final decision. */
const WAITING = new Set(["needs_more_work", "waiting_for_human"]);
const RESEARCHING = new Set(["running", "queued", "pending", "planning"]);

const time = (value: string | Date) => { const t = new Date(value).getTime(); return Number.isFinite(t) ? t : 0; };
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");
const money = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };

/** "23 Sep"; with the UTC time ("18 Nov 19:05") when another run started the same day. */
export function runLabel(created: Date, sameDay: boolean): string {
  const base = `${created.getUTCDate()} ${MONTHS[created.getUTCMonth()]}`;
  return sameDay ? `${base} ${pad(created.getUTCHours())}:${pad(created.getUTCMinutes())}` : base;
}

/** A run waiting at the plan gate is not a final decision: it never becomes current and never supersedes one. */
const atPlanGate = (r: RunRow) => r.waiting_stage_key === "research_plan";
const awaitsDecision = (r: RunRow) => WAITING.has(r.status) && !atPlanGate(r);

function outcome(status: string, isCurrent: boolean, planGate: boolean): string {
  if (planGate) return "Needs plan approval";
  if (status === "completed" || status === "approved") return "Completed";
  if (status === "failed" || status === "cancelled") return "Stopped";
  if (WAITING.has(status)) return isCurrent ? "Needs your decision" : "Superseded";
  if (RESEARCHING.has(status)) return "Researching";
  const words = status.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

/** Runs as bars, oldest first, with the total cost. Only the newest waiting run is `current`. */
export function runBars(rows: readonly RunRow[] | null | undefined): { runs: RunBarItem[]; total: number } {
  const sorted = [...(rows ?? [])].sort((a, b) => time(a.created_at) - time(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const perDay = new Map<string, number>();
  for (const r of sorted) { const k = dayKey(new Date(time(r.created_at))); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  const newestWaiting = [...sorted].reverse().find(awaitsDecision)?.id ?? null;
  const runs = sorted.map((r) => {
    const created = new Date(time(r.created_at));
    const current = r.id === newestWaiting;
    return { id: String(r.id), label: runLabel(created, (perDay.get(dayKey(created)) ?? 0) > 1), outcome: outcome(String(r.status ?? ""), current, atPlanGate(r)), cost: money(r.actual_cost_usd), current };
  });
  return { runs, total: runs.reduce((sum, r) => sum + r.cost, 0) };
}
