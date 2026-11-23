// P3: AC-10 one per company, AC-11 allowed decisions, AC-12 decision body, AC-13 decision card.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { read } from "./support";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/none";
const queue = () => import("../../../src/lib/review/review-queue");
const view = () => import("../../../src/lib/review/review-view");

const row = (run_id: string, asset_id: string, created_at: string) => ({ run_id, asset_id, run_type: "full_initiation", research_question: null,
  asset_name: asset_id, asset_slug: asset_id, asset_kind: "equity", priority: null, created_at, completed_at: null });

test("AC-10: one current run per company; reviewCount counts only those", async () => {
  const { groupReviewQueue, reviewCount } = await queue();
  const grouped = groupReviewQueue([row("r1", "sofi", "2026-09-23T00:00:00Z"), row("r2", "sofi", "2026-11-18T19:05:00Z"), row("r3", "meli", "2026-11-01T00:00:00Z")]);
  assert.equal(grouped.find((g) => g.run_id === "r2")!.replaced_by, null);
  assert.equal(grouped.find((g) => g.run_id === "r1")!.replaced_by, "r2");
  assert.equal(reviewCount(grouped), 2);
  assert.equal(reviewCount(null), 0);
  assert.equal(reviewCount({}), 0);
});

test("AC-10: the nav badge counts current reviews only", () => {
  assert.match(read("src/components/app-shell.tsx"), /reviewCount\(/);
});

const summary = (review: Record<string, unknown> | null, conclusion_status: string | null = "complete") => ({
  currency: "USD", price: 14.28, price_verified: false, value: 8.8, gap: -0.3838, valuation_complete: true, withheld_reason: null, conclusion_status, review,
});

test("AC-11: SoFi: tracking allowed, position blocked with reasons, acknowledgement required", async () => {
  const { decisionOptions } = await view();
  const o = decisionOptions(summary({ verdict: "conditional_pass", open_severe: 16, blocking: ["The check of what today's price assumes was never done."], trackable: true, positionable: false }, "withheld") as never);
  assert.equal(o.tracking.allowed, true);
  assert.equal(o.position.allowed, false);
  assert.ok(o.position.reasons.includes("The AI review didn't pass"));
  assert.ok(o.position.reasons.includes("The report withholds a conclusion"));
  assert.ok(o.position.reasons.some((r: string) => /price assumes/.test(r)));
  assert.equal(o.ackRequired, true);
});

test("AC-11: a passing review with a full conclusion allows both", async () => {
  const { decisionOptions } = await view();
  const o = decisionOptions(summary({ verdict: "pass", open_severe: 0, blocking: [], trackable: true, positionable: true }) as never);
  assert.equal(o.position.allowed, true);
  assert.deepEqual(o.position.reasons, []);
  assert.equal(o.tracking.allowed, true);
  assert.equal(o.ackRequired, false);
});

test("AC-11: no stored review allows no approval", async () => {
  const { decisionOptions } = await view();
  for (const s of [null, summary(null)]) {
    const o = decisionOptions(s as never);
    assert.equal(o.position.allowed, false);
    assert.equal(o.tracking.allowed, false);
    assert.ok(o.position.reasons.includes("No AI review stored for this report"));
  }
});

test("AC-12: reviewBody maps choices to the route's statuses", async () => {
  const { reviewBody } = await view();
  const map: Record<string, string> = { position: "approved_for_position", tracking: "approved_for_tracking", watch: "watchlist", back: "needs_more_work", reject: "reject" };
  for (const [choice, status] of Object.entries(map)) {
    assert.deepEqual(reviewBody(choice as never, { ack: true, reportHash: "h1" }), { status, acknowledgeFindings: true, reportHash: "h1" });
  }
  assert.throws(() => reviewBody("buy" as never, { ack: false, reportHash: null }));
});

test("AC-13: the decision card blocks what isn't allowed and starts with Record disabled", async () => {
  const { ReviewDecision } = await import("../../../src/components/review-decision");
  const options = { position: { allowed: false, reasons: ["The AI review didn't pass"] }, tracking: { allowed: true }, ackRequired: true };
  const html = renderToStaticMarkup(<ReviewDecision options={options} onSubmit={async () => {}} />);
  assert.ok((html.match(/<button/g) ?? []).length >= 6, "five options and Record");
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /The AI review didn&#x27;t pass|The AI review didn't pass/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^<]*Record decision/);
});
