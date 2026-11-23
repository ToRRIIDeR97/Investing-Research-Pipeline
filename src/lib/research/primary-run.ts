/**
 * Which run a company page shows when no run is asked for. Pure and client-safe; the company page and
 * listAssetOverviews (the run whose valuation Home and the Research list show) use the same order.
 *
 * First match wins:
 * 1. the newest run waiting for the final decision (waiting_for_human, not at the research_plan gate, no final decision);
 * 2. the newest decided or finished run (completed/approved, or a final review decision);
 * 3. the newest run that didn't stop (not failed, cancelled or needs_more_work);
 * 4. the newest run.
 */
import { STOPPED_STATUSES, isFinalDecision } from "./run-status";

export interface PrimaryRunInput {
  id: string; created_at: string | Date; status: string;
  waiting_stage_key?: string | null; latest_decision?: string | null;
}

const time = (value: string | Date) => { const t = new Date(value).getTime(); return Number.isFinite(t) ? t : 0; };

const awaitsFinalDecision = (r: PrimaryRunInput) =>
  r.status === "waiting_for_human" && r.waiting_stage_key !== "research_plan" && !isFinalDecision(r.latest_decision);
const decidedOrFinished = (r: PrimaryRunInput) => r.status === "completed" || r.status === "approved" || isFinalDecision(r.latest_decision);
const didntStop = (r: PrimaryRunInput) => !STOPPED_STATUSES.has(r.status);

/** The run to show and the rule (1-4) that chose it, or null for no runs. */
export function primaryRunChoice<T extends PrimaryRunInput>(runs: readonly T[] | null | undefined): { run: T; rule: 1 | 2 | 3 | 4 } | null {
  const newestFirst = [...(runs ?? [])].sort((a, b) => time(b.created_at) - time(a.created_at) || String(b.id).localeCompare(String(a.id)));
  if (!newestFirst.length) return null;
  const rules = [awaitsFinalDecision, decidedOrFinished, didntStop];
  for (let i = 0; i < rules.length; i++) {
    const run = newestFirst.find(rules[i]);
    if (run) return { run, rule: (i + 1) as 1 | 2 | 3 };
  }
  return { run: newestFirst[0], rule: 4 };
}

/** The id of the run to show, or null for none. */
export function primaryRun(runs: readonly PrimaryRunInput[] | null | undefined): string | null {
  return primaryRunChoice(runs)?.run.id ?? null;
}

/** A run that stopped before review and carries no final decision (the page says so in a short line). */
export const isStoppedRun = (r: { status: string; latest_decision?: string | null } | null | undefined) =>
  Boolean(r && STOPPED_STATUSES.has(r.status) && !isFinalDecision(r.latest_decision));
