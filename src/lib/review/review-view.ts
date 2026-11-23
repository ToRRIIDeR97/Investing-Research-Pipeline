/**
 * Reader text for the final-review page: the AI review's findings grouped by report chapter, in words. Stored
 * finding text is model-written and may name internal fields (report_facts, tv_share_of_ev); those are shown as
 * words. Nothing here changes what the review gate decides (depth.ts reviewGate does).
 */

import type { ReviewSummary } from "./review-queue";

type Row = Record<string, any>;

export type Severity = "critical" | "high" | "medium" | "low" | "other";
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "other"];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", other: "Unrated" };

export interface ReaderFinding { severity: Severity; category: string; issue: string; repair: string | null }
export interface FindingGroup { id: string; title: string; findings: ReaderFinding[]; counts: Partial<Record<Severity, number>>; serious: number }

/** snake_case identifiers inside prose become words: "report_facts defines tv_share_of_ev" → "report facts defines tv share of ev". */
export function plainIdentifiers(text: string): string {
  return text.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (match) => match.replace(/_/g, " "));
}

const severityOf = (value: unknown): Severity => {
  const s = String(value ?? "").toLowerCase();
  return (SEVERITY_ORDER as string[]).includes(s) ? s as Severity : "other";
};
const sentence = (value: unknown) => {
  const text = plainIdentifiers(String(value ?? "").trim());
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
};
const findingText = (f: Row) => f.issue ?? f.message ?? f.description ?? f.summary ?? "";

/** The review's verdict in words ("needs_more_work" → "Needs more work"). */
export const verdictWords = (value: unknown) => sentence(String(value ?? "").replace(/[_-]+/g, " ")) || "No verdict";

/**
 * Findings grouped by the report chapter they name, in the report's chapter order; findings that name no chapter, or a
 * chapter the report doesn't have, come last as "The whole report". Within a group, most severe first.
 */
export function groupFindingsByChapter(review: Row | null | undefined, sections: { id: string; title: string }[]): FindingGroup[] {
  const findings: Row[] = Array.isArray(review?.findings) ? review!.findings : [];
  const titles = new Map(sections.map((s) => [s.id, s.title]));
  const groups = new Map<string, FindingGroup>();
  for (const f of findings) {
    const known = typeof f.section_id === "string" && titles.has(f.section_id);
    const id = known ? f.section_id : "";
    const group: FindingGroup = groups.get(id) ?? { id, title: known ? titles.get(id)! : "The whole report", findings: [], counts: {}, serious: 0 };
    const severity = severityOf(f.severity);
    group.findings.push({ severity, category: sentence(String(f.category ?? "").replace(/[_-]+/g, " ")), issue: sentence(findingText(f)), repair: sentence(f.repair) || null });
    group.counts[severity] = (group.counts[severity] ?? 0) + 1;
    if (severity === "critical" || severity === "high") group.serious += 1;
    groups.set(id, group);
  }
  const order = (id: string) => id ? sections.findIndex((s) => s.id === id) : sections.length;
  return [...groups.values()].sort((a, b) => order(a.id) - order(b.id)).map((g) => ({
    ...g, findings: [...g.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
  }));
}

export type ReviewChoice = "position" | "tracking" | "watch" | "back" | "reject";
export interface DecisionOptions { position: { allowed: boolean; reasons: string[] }; tracking: { allowed: boolean }; ackRequired: boolean }

export const NO_REVIEW = "No AI review stored for this report";
export const REVIEW_FAILED = "The AI review didn't pass";
export const CONCLUSION_WITHHELD = "The report withholds a conclusion";

/**
 * Which decisions the review route will accept, worked out from the same gate it uses (reviewGate's trackable and
 * positionable, the report's conclusion_status and the open serious findings), so the page can say why before the
 * reader tries. The route still decides; this only explains.
 */
export function decisionOptions(summary: Pick<ReviewSummary, "review" | "conclusion_status"> | null | undefined): DecisionOptions {
  const review = summary?.review ?? null;
  if (!review) return { position: { allowed: false, reasons: [NO_REVIEW] }, tracking: { allowed: false }, ackRequired: false };
  const reasons: string[] = [];
  if (!review.positionable || !review.trackable) {
    reasons.push(REVIEW_FAILED);
    for (const b of review.blocking ?? []) reasons.push(sentence(String(b).replace(/\.$/, "")));
  }
  if (summary?.conclusion_status === "withheld") reasons.push(CONCLUSION_WITHHELD);
  const unique = [...new Set(reasons.filter(Boolean))];
  return { position: { allowed: unique.length === 0, reasons: unique }, tracking: { allowed: Boolean(review.trackable) }, ackRequired: review.open_severe > 0 };
}

const STATUS: Record<ReviewChoice, string> = {
  position: "approved_for_position", tracking: "approved_for_tracking", watch: "watchlist", back: "needs_more_work", reject: "reject",
};

/** The review route's body for a choice. An unknown choice throws. */
export function reviewBody(choice: ReviewChoice, { ack, reportHash }: { ack: boolean; reportHash: string | null | undefined }) {
  const status = Object.prototype.hasOwnProperty.call(STATUS, choice) ? STATUS[choice] : undefined;
  if (!status) throw new Error(`Unknown review choice: ${String(choice)}`);
  return { status, acknowledgeFindings: ack, reportHash };
}

/** The review route's refusals in words. Unknown codes fall back to the server's message with identifiers as words. */
export function refusalWords(code: unknown, message?: unknown): string {
  switch (code) {
    case "REPORT_REVIEW_FAILED": return "The AI review didn't pass, so this report can't be approved. Send it back for more work, put it on the watchlist or reject it.";
    case "REVIEW_BLOCKS_POSITION": return "The AI review blocks approval for a position. You can approve it for tracking or send it back for more work.";
    case "RESEARCH_INCOMPLETE": return "The report withholds a conclusion, so it can't be approved for a position. Approve it for tracking or send it back for more work.";
    case "FINDINGS_NOT_ACKNOWLEDGED": return "Tick that you've read the serious findings before approving.";
    case "STALE_REPORT": return "The report changed since this page loaded. Reload the page and read the current report before deciding.";
    case "STALE_REPORT_INPUTS": return "The research changed since this report was written. Send it back so the report is redrafted.";
    case "REPORT_NOT_READY": return "The report isn't ready to approve yet.";
    default: return typeof message === "string" && message.trim() ? sentence(message) : "The decision couldn't be saved. Try again.";
  }
}
