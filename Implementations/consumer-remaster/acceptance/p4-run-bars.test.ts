// P4: AC-14 (labels pinned to UTC since AC-21 made the viewer's zone the default) runs become bars with real costs and plain outcomes.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";

const run = (id: string, created_at: string, status: string, actual_cost_usd: string, waiting_stage_key: string | null = status === "waiting_for_human" ? "human_review" : null) =>
  ({ id, created_at, status, actual_cost_usd, budget_limit_usd: "10", waiting_stage_key });

test("AC-14: SoFi runs map to labelled, costed bars", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([
    run("a", "2026-09-23T10:00:00Z", "waiting_for_human", "0.52"),
    run("b", "2026-09-24T10:00:00Z", "completed", "2.68"),
    run("c", "2026-11-18T13:49:00Z", "failed", "9.21"),
    run("d", "2026-11-18T19:05:00Z", "waiting_for_human", "4.86"),
    run("e", "2026-11-18T21:12:00Z", "needs_more_work", "9.74"),
  ], { timeZone: "UTC" });
  assert.deepEqual(bars.runs.map((b) => b.outcome), ["Superseded", "Completed", "Stopped", "Needs your decision", "Stopped"]);
  assert.equal(bars.runs[0].label, "23 Sep");
  assert.match(bars.runs[3].label, /^18 Nov \d{2}:\d{2}$/, "same-day runs carry a time");
  assert.equal(bars.runs[3].current, true);
  assert.equal(bars.runs[0].cost, 0.52);
  assert.equal(Number(bars.total.toFixed(2)), 27.01);
});

test("AC-14: a run waiting for plan approval says so and is not the decision", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([
    run("a", "2026-11-01T10:00:00Z", "waiting_for_human", "4.00"),
    run("b", "2026-11-20T10:00:00Z", "waiting_for_human", "0.21", "research_plan"),
  ], { timeZone: "UTC" });
  assert.deepEqual(bars.runs.map((b) => b.outcome), ["Needs your decision", "Needs plan approval"]);
  assert.equal(bars.runs[0].current, true, "the older final-report run is still the decision to make");
  assert.ok(!bars.runs[1].current);
});

test("AC-14: a run the pipeline stopped (needs_more_work) is Stopped, never the decision", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([run("x", "2026-11-18T19:05:00Z", "waiting_for_human", "4.86"), run("y", "2026-11-18T21:12:00Z", "needs_more_work", "9.74")], { timeZone: "UTC" });
  assert.deepEqual(bars.runs.map((b) => b.outcome), ["Needs your decision", "Stopped"]);
  assert.equal(bars.runs[0].current, true);
  assert.ok(!bars.runs[1].current);
});

test("AC-14: no runs, no bars", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([], { timeZone: "UTC" });
  assert.deepEqual(bars.runs, []);
  assert.equal(bars.total, 0);
});
