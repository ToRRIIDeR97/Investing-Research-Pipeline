import type postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "@/lib/research/version";
import { buildResearchMemo } from "@/lib/research/reporting/research-memo";
import { chooseArtifactVersions, loadArtifactMeta, loadReportPins } from "@/lib/research/reporting/report-pins";
import { reviewGate } from "@/lib/research/reporting/depth";
import { groupReviewQueue, type ReviewQueueRow } from "./queue-rules";

/**
 * The final-report review queue (gate 2). Each company shows once: its newest waiting run. Older waiting runs of the
 * same company are kept in the list, marked `replaced_by`, so the queue, Home and the nav badge count the same
 * decisions (`reviewCount`). The newest run of each company carries a summary (value per share against price, from
 * the versions its report was built from, the AI review of that report, and whether the report withholds a
 * conclusion) so the queue says what is being decided.
 */

export { groupReviewQueue, currentReviews, reviewCount, type ReviewQueueRow } from "./queue-rules";

type Sql = ReturnType<typeof postgres>;

export interface ReviewSummary {
  currency: string; price: number | null; price_verified: boolean; value: number | null; gap: number | null;
  valuation_complete: boolean; withheld_reason: string | null;
  /** The report document's conclusion_status ("withheld" when the report withholds a conclusion); null without a report. */
  conclusion_status: string | null;
  /** The AI review of the report under decision (reviewGate), or null when none is stored for that report version. */
  review: { verdict: string | null; open_severe: number; blocking: string[]; trackable: boolean; positionable: boolean } | null;
}
export interface ReviewQueueItem extends ReviewQueueRow {
  /** The newer waiting run of the same company, or null for the run to decide on. */
  replaced_by: string | null;
  summary: ReviewSummary | null;
}

const iso = (value: unknown) => value == null ? null : new Date(value as string).toISOString();

const SUMMARY_TYPES = ["report_facts", "valuation_scenario_set"] as const;

/** Value per share against price, the AI review gate and the conclusion status for one run, read the way the memo reads them. */
export async function loadReviewSummary(sql: Sql, runId: string): Promise<ReviewSummary | null> {
  const [meta, pins, docs] = await Promise.all([
    loadArtifactMeta(sql, runId, SUMMARY_TYPES),
    loadReportPins(sql, runId, SUMMARY_TYPES),
    sql`
      WITH doc AS (
        SELECT content_json ->> 'content_hash' AS hash, content_json ->> 'conclusion_status' AS conclusion_status FROM research_artifacts
        WHERE research_run_id = ${runId} AND artifact_type = 'report_document' AND status <> 'superseded'
        ORDER BY artifact_version DESC, created_at DESC LIMIT 1
      )
      SELECT doc.conclusion_status, r.content_json FROM doc
      LEFT JOIN LATERAL (
        SELECT content_json FROM research_artifacts
        WHERE research_run_id = ${runId} AND artifact_type = 'report_review' AND content_json ->> 'report_hash' = doc.hash
        ORDER BY artifact_version DESC, created_at DESC LIMIT 1
      ) r ON true`,
  ]);
  const ids = Object.values(chooseArtifactVersions(meta, pins, (status) => status !== "superseded").chosen);
  const rows = ids.length ? await sql`SELECT artifact_type, artifact_version, content_json FROM research_artifacts WHERE id = ANY(${ids})` : [];
  const memo = buildResearchMemo(rows.map((r) => ({ artifact_type: r.artifact_type, artifact_version: r.artifact_version, content_json: r.content_json ?? {} })), null);
  const conclusion_status = docs[0]?.conclusion_status == null ? null : String(docs[0].conclusion_status);
  const stored = docs[0]?.content_json as Record<string, unknown> | null | undefined;
  const gate = stored ? reviewGate(stored) : null;
  const review = gate ? { verdict: gate.verdict == null ? null : String(gate.verdict), open_severe: gate.open_severe, blocking: gate.blocking,
    trackable: gate.trackable, positionable: gate.positionable } : null;
  if (!memo) return review || conclusion_status ? { currency: "USD", price: null, price_verified: false, value: null, gap: null, valuation_complete: false,
    withheld_reason: null, conclusion_status, review } : null;
  const v = memo.verdict;
  return { currency: memo.currency, price: v.price, price_verified: v.priceVerified, value: v.values.base, gap: v.gap,
    valuation_complete: v.valuationComplete, withheld_reason: v.withheldReason, conclusion_status, review };
}

export async function loadReviewQueue(sql: Sql): Promise<ReviewQueueItem[]> {
  const rows = await sql`
    SELECT rr.id AS run_id, rr.asset_id, rr.run_type, rr.research_question, rr.created_at, rr.completed_at,
      a.canonical_name AS asset_name, a.slug AS asset_slug, a.asset_kind,
      (SELECT rd.priority FROM review_decisions rd WHERE rd.research_run_id = rr.id ORDER BY rd.reviewed_at DESC LIMIT 1) AS priority
    FROM research_runs rr
    JOIN assets a ON rr.asset_id = a.id
    JOIN research_stages hs ON hs.research_run_id = rr.id AND hs.stage_key = 'human_review' AND hs.status = 'waiting_for_human'
    WHERE rr.pipeline_version = ${CURRENT_PIPELINE_VERSION}
      AND rr.status = 'waiting_for_human'
      AND NOT EXISTS (
        SELECT 1 FROM review_decisions approved
        WHERE approved.research_run_id = rr.id AND approved.status IN ('approved_for_tracking', 'approved_for_position')
      )
    ORDER BY rr.created_at DESC
    LIMIT 50
  `;
  const grouped = groupReviewQueue(rows.map((r) => ({
    run_id: String(r.run_id), asset_id: String(r.asset_id), run_type: String(r.run_type), research_question: r.research_question ?? null,
    asset_name: String(r.asset_name), asset_slug: String(r.asset_slug), asset_kind: String(r.asset_kind), priority: r.priority ?? null,
    created_at: iso(r.created_at)!, completed_at: iso(r.completed_at),
  })));
  // A summary that can't be built (unexpected artifact shapes) is left out; the row still shows.
  const summaries = await Promise.all(grouped.map((item) => item.replaced_by ? null
    : loadReviewSummary(sql, item.run_id).catch((error) => { console.error(`Review summary for run ${item.run_id} could not be built`, error); return null; })));
  return grouped.map((item, i) => ({ ...item, summary: summaries[i] }));
}
