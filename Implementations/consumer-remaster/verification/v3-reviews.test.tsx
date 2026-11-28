// V3 (P3/P4): decision rules and run bars from other angles.
import "./v-support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";
const sum = (review: Record<string, unknown> | null, conclusion_status: string | null = "complete") => ({
  currency: "USD", price: 10, price_verified: true, value: 12, gap: 0.2, valuation_complete: true, withheld_reason: null, conclusion_status, review });

test("V3/AC-10: items without a replaced_by field count as current", async () => {
  const { reviewCount } = await import("../../../src/lib/review/review-queue");
  assert.equal(reviewCount([{ run_id: "a" }, { run_id: "b", replaced_by: "a" }, { run_id: "c", replaced_by: null }] as never), 2);
});

test("V3/AC-11: positionable but withheld still blocks a position, with only that reason", async () => {
  const { decisionOptions } = await import("../../../src/lib/review/review-view");
  const o = decisionOptions(sum({ verdict: "pass", open_severe: 0, blocking: [], trackable: true, positionable: true }, "withheld") as never);
  assert.equal(o.position.allowed, false);
  assert.deepEqual(o.position.reasons, ["The report withholds a conclusion"]);
});

test("V3/AC-11: a failed review allows neither approval", async () => {
  const { decisionOptions } = await import("../../../src/lib/review/review-view");
  const o = decisionOptions(sum({ verdict: "fail", open_severe: 3, blocking: [], trackable: false, positionable: false }) as never);
  assert.equal(o.tracking.allowed, false);
  assert.equal(o.position.allowed, false);
  assert.equal(o.ackRequired, true);
});

test("V3/AC-12: the acknowledgement and hash pass through unchanged", async () => {
  const { reviewBody } = await import("../../../src/lib/review/review-view");
  assert.deepEqual(reviewBody("watch", { ack: false, reportHash: null }), { status: "watchlist", acknowledgeFindings: false, reportHash: null });
});

test("V3/AC-13: when everything is allowed nothing is disabled but Record", async () => {
  const { ReviewDecision } = await import("../../../src/components/review-decision");
  const html = renderToStaticMarkup(<ReviewDecision options={{ position: { allowed: true, reasons: [] }, tracking: { allowed: true }, ackRequired: false }} onSubmit={async () => {}} />);
  assert.doesNotMatch(html, /aria-disabled="true"/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
});

test("V3/AC-14: running and approved runs, different days carry no time, bad costs are zero", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([
    { id: "b", created_at: "2026-10-02T09:00:00Z", status: "running", actual_cost_usd: "1.10", budget_limit_usd: null },
    { id: "a", created_at: "2026-10-01T09:00:00Z", status: "approved", actual_cost_usd: "oops", budget_limit_usd: null },
  ]);
  assert.deepEqual(bars.runs.map((r) => r.id), ["a", "b"], "oldest first whatever the input order");
  assert.deepEqual(bars.runs.map((r) => r.outcome), ["Completed", "Researching"]);
  assert.deepEqual(bars.runs.map((r) => r.label), ["1 Oct", "2 Oct"]);
  assert.equal(bars.runs[0].cost, 0);
  assert.ok(!bars.runs.some((r) => r.current), "no waiting run, nothing current");
});
