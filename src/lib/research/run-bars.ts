/**
 * A company's research runs as RunsBars input (src/components/interactive/runs-bars.tsx): oldest first, a short date
 * label, the outcome in plain words and the run's real cost. Pure; labels and same-day detection are in the given IANA
 * time zone, defaulting to the viewer's zone (in the browser, the reader's own clock).
 */
import { isFinalDecision } from "./run-status";

export interface RunRow {
  id: string; created_at: string | Date; status: string; actual_cost_usd?: unknown; budget_limit_usd?: unknown;
  /** The stage the run waits at for a person (GET /api/assets/[id]/research-runs), e.g. "research_plan" or "human_review". */
  waiting_stage_key?: string | null;
  /** The newest review_decisions.status for the run; a final decision (approved, watchlist, reject) reads Decided. */
  latest_decision?: string | null;
}
export interface RunBarItem { id: string; label: string; outcome: string; cost: number; current: boolean }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Only waiting_for_human waits on a person. needs_more_work is a run the pipeline stopped (failRun on a failed stage,
 *  the quality gate or the budget); a reviewer's send-back sets the run to waiting_for_human. */
const WAITING = new Set(["waiting_for_human"]);
const RESEARCHING = new Set(["running", "queued", "pending", "planning"]);

const time = (value: string | Date) => { const t = new Date(value).getTime(); return Number.isFinite(t) ? t : 0; };
const pad = (n: number) => String(n).padStart(2, "0");
const money = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };

/** The viewer's IANA zone (UTC when the runtime reports none). */
export function viewerTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }
const PARTS = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" } as const;

/** A date's calendar parts in `timeZone` (UTC for a zone the runtime doesn't know). */
export function localParts(date: Date, timeZone: string): LocalParts {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-GB", { ...PARTS, timeZone }); } catch { format = new Intl.DateTimeFormat("en-GB", { ...PARTS, timeZone: "UTC" }); }
  const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}
const dayKey = (p: LocalParts) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;

/** "23 Sep"; with the local time ("18 Nov 19:05") when another run started the same local day. */
export function runLabel(created: Date, sameDay: boolean, timeZone: string = viewerTimeZone()): string {
  const p = localParts(created, timeZone);
  const base = `${p.day} ${MONTHS[p.month - 1]}`;
  return sameDay ? `${base} ${pad(p.hour)}:${pad(p.minute)}` : base;
}

/** A run waiting at the plan gate is not a final decision: it never becomes current and never supersedes one. */
const atPlanGate = (r: RunRow) => r.waiting_stage_key === "research_plan";
/** A final review decision (approved, watchlist, reject) settles the run; a needs_more_work send-back doesn't. */
const decided = (r: RunRow) => isFinalDecision(r.latest_decision);
const awaitsDecision = (r: RunRow) => WAITING.has(r.status) && !atPlanGate(r) && !decided(r);

function outcome(status: string, isCurrent: boolean, planGate: boolean, isDecided: boolean): string {
  if (isDecided) return "Decided";
  if (planGate) return "Needs plan approval";
  if (status === "completed" || status === "approved") return "Completed";
  if (status === "failed" || status === "cancelled" || status === "needs_more_work") return "Stopped";
  if (WAITING.has(status)) return isCurrent ? "Needs your decision" : "Superseded";
  if (RESEARCHING.has(status)) return "Researching";
  const words = status.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

/**
 * Runs as bars, oldest first, with the total cost. Only the newest run waiting for the final decision (no final
 * decision recorded) is `current`. `timeZone` (IANA) sets the labels and the same-day check; default the viewer's zone.
 */
export function runBars(rows: readonly RunRow[] | null | undefined, { timeZone }: { timeZone?: string } = {}): { runs: RunBarItem[]; total: number } {
  const zone = timeZone || viewerTimeZone();
  const sorted = [...(rows ?? [])].sort((a, b) => time(a.created_at) - time(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const keyOf = (r: RunRow) => dayKey(localParts(new Date(time(r.created_at)), zone));
  const perDay = new Map<string, number>();
  for (const r of sorted) { const k = keyOf(r); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  const newestWaiting = [...sorted].reverse().find(awaitsDecision)?.id ?? null;
  const runs = sorted.map((r) => {
    const created = new Date(time(r.created_at));
    const current = r.id === newestWaiting;
    return { id: String(r.id), label: runLabel(created, (perDay.get(keyOf(r)) ?? 0) > 1, zone),
      outcome: outcome(String(r.status ?? ""), current, atPlanGate(r), decided(r)), cost: money(r.actual_cost_usd), current };
  });
  return { runs, total: runs.reduce((sum, r) => sum + r.cost, 0) };
}
