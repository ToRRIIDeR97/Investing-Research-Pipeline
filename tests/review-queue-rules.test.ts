import { test } from "node:test";
import assert from "node:assert/strict";
import { currentReviews, groupReviewQueue, reviewCount } from "../src/lib/review/queue-rules";
import { decisionOptions, refusalWords, reviewBody, reviewOutcomeLabel, withReportCheck, REPORT_UNCHECKED } from "../src/lib/review/review-view";
import { assembleReviewQueue } from "../src/lib/review/review-queue";

test("assembleReviewQueue: the light path loads no summary; the full path loads one per company", async () => {
  const rows = [row("a", "sofi", "2026-09-01T00:00:00Z"), row("b", "sofi", "2026-11-01T00:00:00Z"), row("c", "meli", "2026-10-01T00:00:00Z")];
  const light = await assembleReviewQueue(rows, null);
  assert.deepEqual(light.map((i) => [i.run_id, i.replaced_by, i.summary]), [["b", null, null], ["c", null, null], ["a", "b", null]]);
  assert.equal(reviewCount(light), 2);
  const asked: string[] = [];
  const full = await assembleReviewQueue(rows, async (runId) => { asked.push(runId); return runId === "c" ? Promise.reject(new Error("bad shape")) : null; });
  assert.deepEqual(asked.sort(), ["b", "c"]);
  assert.equal(reviewCount(full), reviewCount(light));
});

test("withReportCheck blocks both approvals and sending back for an unchecked report, and STALE_REPORT says why", () => {
  const passing = decisionOptions({ conclusion_status: "qualified", review: { verdict: "pass", open_severe: 0, blocking: [], trackable: true, positionable: true } });
  assert.equal(withReportCheck(passing, false), passing);
  const o = withReportCheck(passing, true);
  assert.deepEqual(o.position, { allowed: false, reasons: [REPORT_UNCHECKED] });
  assert.deepEqual(o.tracking, { allowed: false, reason: REPORT_UNCHECKED });
  assert.deepEqual(o.back, { allowed: false, reason: REPORT_UNCHECKED });
  assert.match(refusalWords("STALE_REPORT", "x", { reportUnchecked: true }), /hasn't passed its checks/);
  assert.match(refusalWords("STALE_REPORT", "x"), /Reload the page/);
});

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

// pipeline-simplification: the AI verdict is advisory, so REPORT_REVIEW_FAILED now means no finished review, and the
// review's label shows the actual verdict rather than "Passed for tracking".
test("REPORT_REVIEW_FAILED says the AI review is missing, and the outcome label shows the actual verdict", () => {
  const words = refusalWords("REPORT_REVIEW_FAILED", "raw");
  assert.match(words, /missing or hasn't finished/);
  assert.doesNotMatch(words, /didn't pass/);
  assert.equal(reviewOutcomeLabel(null), "No AI review");
  assert.equal(reviewOutcomeLabel({ verdict: "pass", trackable: true, positionable: true }), "AI review: passed");
  assert.equal(reviewOutcomeLabel({ verdict: "needs_more_work", trackable: true, positionable: false }), "AI review: needs more work, open for tracking");
  assert.equal(reviewOutcomeLabel({ verdict: "fail", trackable: true, positionable: false }), "AI review: failed, open for tracking");
  assert.equal(reviewOutcomeLabel({ verdict: null, trackable: false, positionable: false }), "AI review: no verdict");
});
