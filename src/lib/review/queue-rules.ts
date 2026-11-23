/**
 * The review queue's one-per-company rule, pure and client-safe (the nav badge, Home and the Research list import it
 * without the server-side summary code in review-queue.ts, which re-exports these).
 */

export interface ReviewQueueRow {
  run_id: string; asset_id: string; run_type: string; research_question: string | null;
  asset_name: string; asset_slug: string; asset_kind: string; priority: string | null;
  created_at: string; completed_at: string | null;
}

/** Newest first; one current run per company, older waiting runs of that company point at it. Duplicate rows collapse. */
export function groupReviewQueue<T extends ReviewQueueRow>(rows: T[]): (T & { replaced_by: string | null })[] {
  const unique = [...new Map(rows.map((r) => [r.run_id, r])).values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.run_id.localeCompare(a.run_id));
  const newest = new Map<string, string>();
  return unique.map((row) => {
    const current = newest.get(row.asset_id);
    if (!current) newest.set(row.asset_id, row.run_id);
    return { ...row, replaced_by: current ?? null };
  });
}

/** Only the runs to decide on (one per company). */
export const currentReviews = <T extends { replaced_by?: string | null }>(items: T[]) => items.filter((item) => !item.replaced_by);

/** How many decisions are waiting: items whose `replaced_by` is null or missing; 0 for anything that isn't a list. */
export function reviewCount(queue: unknown): number {
  if (!Array.isArray(queue)) return 0;
  return queue.filter((item) => item && typeof item === "object" && (item as { replaced_by?: unknown }).replaced_by == null).length;
}
