import { test } from "node:test";
import assert from "node:assert/strict";
import { isStoppedRun, primaryRun, primaryRunChoice } from "../src/lib/research/primary-run";
import { companyStatusWord, runStatusWord, stageOf, stateTone } from "../src/lib/research/run-status";
import { isTestAsset } from "../src/lib/research/test-assets";
import { groupReviewQueue, reviewCount } from "../src/lib/review/queue-rules";
import { memoStatus } from "../src/lib/research/reporting/research-memo";

const run = (id: string, created_at: string, status: string, extra: { waiting_stage_key?: string | null; latest_decision?: string | null } = {}) => ({ id, created_at, status, ...extra });

test("primaryRunChoice names the rule that chose the run", () => {
  assert.equal(primaryRunChoice([]), null);
  const waiting = primaryRunChoice([run("w", "2026-11-01T00:00:00Z", "waiting_for_human", { waiting_stage_key: "human_review" }), run("s", "2026-11-02T00:00:00Z", "needs_more_work")]);
  assert.deepEqual([waiting?.run.id, waiting?.rule], ["w", 1]);
  const stopped = primaryRunChoice([run("a", "2026-11-01T00:00:00Z", "failed"), run("b", "2026-11-02T00:00:00Z", "needs_more_work")]);
  assert.deepEqual([stopped?.run.id, stopped?.rule], ["b", 4]);
  assert.equal(isStoppedRun(stopped?.run), true);
});

test("primaryRun: a waiting run with a final decision is decided, not waiting; a send-back still waits", () => {
  const runs = [
    run("done", "2026-10-01T00:00:00Z", "completed"),
    run("watched", "2026-10-05T00:00:00Z", "waiting_for_human", { waiting_stage_key: "human_review", latest_decision: "watchlist" }),
  ];
  assert.equal(primaryRun(runs), "watched", "rule 2: the newest decided run");
  assert.equal(primaryRun([...runs, run("back", "2026-10-07T00:00:00Z", "waiting_for_human", { waiting_stage_key: "human_review", latest_decision: "needs_more_work" })]), "back");
  assert.equal(isStoppedRun(run("x", "2026-10-01T00:00:00Z", "needs_more_work", { latest_decision: "approved_for_tracking" })), false, "a decided run isn't shown as stopped");
});

test("status words: a final decision reads Decided everywhere; needs_more_work changes nothing", () => {
  assert.equal(runStatusWord("needs_more_work", null, "approved_for_tracking"), "Decided");
  assert.equal(runStatusWord("waiting_for_human", "human_review", "approved_for_position"), "Decided");
  assert.equal(runStatusWord("needs_more_work", null, "needs_more_work"), "Stopped");
  assert.equal(companyStatusWord([run("w", "2026-11-01T00:00:00Z", "waiting_for_human", { waiting_stage_key: "human_review", latest_decision: "reject" })]), "Decided");
  assert.equal(companyStatusWord([
    run("w", "2026-11-01T00:00:00Z", "waiting_for_human", { waiting_stage_key: "human_review", latest_decision: "needs_more_work" }),
    run("s", "2026-11-02T00:00:00Z", "needs_more_work"),
  ]), "Needs your decision");
  const asset = { id: "a", latest_run: { status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: "watchlist" } };
  assert.equal(stageOf(asset).label, "Decided");
  assert.equal(memoStatus({ runStatus: "needs_more_work", latestDecision: "reject" })!.label, "Decided");
  assert.equal(memoStatus({ runStatus: "waiting_for_human", humanReviewStatus: "waiting_for_human", latestDecision: "pending" })!.label, "Needs your decision");
});

test("groupReviewQueue: an older decided run drops out on its own; a decided newest run takes the company out", () => {
  const row = (run_id: string, asset_id: string, created_at: string, latest_decision: string | null) => ({ run_id, asset_id, run_type: "full_initiation",
    research_question: null, asset_name: asset_id, asset_slug: asset_id, asset_kind: "equity", priority: null, created_at, completed_at: null, latest_decision });
  const q = groupReviewQueue([row("a", "sofi", "2026-09-01T00:00:00Z", "reject"), row("b", "sofi", "2026-10-01T00:00:00Z", null),
    row("c", "meli", "2026-09-01T00:00:00Z", null), row("d", "meli", "2026-10-01T00:00:00Z", "approved_for_tracking")]);
  assert.deepEqual(q.map((r) => [r.run_id, r.replaced_by]), [["b", null]]);
  assert.equal(reviewCount(q), 1);
});

test("isTestAsset: status test or an -e2e-<hex> slug", () => {
  assert.equal(isTestAsset({ slug: "meli-e2e-ABCDEF12", canonical_name: "MercadoLibre", status: null }), true);
  assert.equal(isTestAsset({ slug: "sofi-e2e-12345", canonical_name: "SoFi", status: "active" }), false, "fewer than six hex characters");
  assert.equal(isTestAsset({ slug: "x", canonical_name: "X", status: "TEST" }), true);
  assert.equal(isTestAsset({ slug: "x", canonical_name: "X", status: null }), false);
});

test("stateTone maps raw operational states to Tag tones", () => {
  assert.deepEqual(["completed", "failed", "running", "skipped"].map(stateTone), ["good", "bad", "waiting", "neutral"]);
});
