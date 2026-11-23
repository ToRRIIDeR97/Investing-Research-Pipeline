import { test } from "node:test";
import assert from "node:assert/strict";
import { currentReviews, groupReviewQueue, reviewCount } from "../src/lib/review/queue-rules";
import { decisionOptions, refusalWords, reviewBody } from "../src/lib/review/review-view";

const row = (run_id: string, asset_id: string, created_at: string) => ({ run_id, asset_id, run_type: "full_initiation", research_question: null,
  asset_name: asset_id, asset_slug: asset_id, asset_kind: "equity", priority: null, created_at, completed_at: null });

test("groupReviewQueue keeps the newest run per company, collapses duplicates and orders newest first", () => {
  const grouped = groupReviewQueue([row("a", "sofi", "2026-09-01T00:00:00Z"), row("b", "sofi", "2026-10-01T00:00:00Z"),
    row("b", "sofi", "2026-10-01T00:00:00Z"), row("c", "sofi", "2026-11-01T00:00:00Z"), row("d", "meli", "2026-10-15T00:00:00Z")]);
  assert.deepEqual(grouped.map((g) => [g.run_id, g.replaced_by]), [["c", null], ["d", null], ["b", "c"], ["a", "c"]]);
  assert.deepEqual(currentReviews(grouped).map((g) => g.run_id), ["c", "d"]);
  assert.equal(reviewCount(grouped), 2);
});

test("reviewCount treats a missing replaced_by as current and ignores non-objects", () => {
  assert.equal(reviewCount([{ run_id: "x" }, { replaced_by: undefined }, { replaced_by: "x" }, null, 3]), 2);
  assert.equal(reviewCount(undefined), 0);
  assert.equal(reviewCount("queue"), 0);
});

test("decisionOptions: a failed review blocks both approvals, with no blocking list repeated twice", () => {
  const o = decisionOptions({ conclusion_status: "qualified", review: { verdict: "needs_more_work", open_severe: 0, blocking: ["the review verdict is needs_more_work", "the review verdict is needs_more_work"], trackable: false, positionable: false } });
  assert.equal(o.tracking.allowed, false);
  assert.equal(o.position.allowed, false);
  assert.deepEqual(o.position.reasons, ["The AI review didn't pass", "The review verdict is needs more work"]);
  assert.equal(o.ackRequired, false);
});

test("decisionOptions: a passing review over a withheld conclusion still blocks a position", () => {
  const o = decisionOptions({ conclusion_status: "withheld", review: { verdict: "pass", open_severe: 2, blocking: [], trackable: true, positionable: true } });
  assert.deepEqual(o.position.reasons, ["The report withholds a conclusion"]);
  assert.equal(o.tracking.allowed, true);
  assert.equal(o.ackRequired, true);
});

test("reviewBody carries a null hash through and refusalWords explains each route code", () => {
  assert.deepEqual(reviewBody("watch", { ack: false, reportHash: null }), { status: "watchlist", acknowledgeFindings: false, reportHash: null });
  for (const code of ["REPORT_REVIEW_FAILED", "REVIEW_BLOCKS_POSITION", "RESEARCH_INCOMPLETE", "FINDINGS_NOT_ACKNOWLEDGED", "STALE_REPORT", "STALE_REPORT_INPUTS"]) {
    const words = refusalWords(code, "raw");
    assert.ok(words.length > 20 && !/_/.test(words) && words !== "Raw", code);
  }
  assert.equal(refusalWords("SOMETHING_ELSE", "the run_id was wrong"), "The run id was wrong");
  assert.equal(refusalWords(undefined), "The decision couldn't be saved. Try again.");
});
