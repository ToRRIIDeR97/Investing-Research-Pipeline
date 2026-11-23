// P4: AC-14 runs become bars with real costs and plain outcomes.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";

const run = (id: string, created_at: string, status: string, actual_cost_usd: string) => ({ id, created_at, status, actual_cost_usd, budget_limit_usd: "10" });

test("AC-14: SoFi runs map to labelled, costed bars", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([
    run("a", "2026-09-23T10:00:00Z", "needs_more_work", "0.52"),
    run("b", "2026-09-24T10:00:00Z", "completed", "2.68"),
    run("c", "2026-11-18T13:49:00Z", "failed", "9.21"),
    run("d", "2026-11-18T19:05:00Z", "needs_more_work", "4.86"),
    run("e", "2026-11-18T21:12:00Z", "cancelled", "9.74"),
  ]);
  assert.deepEqual(bars.runs.map((b) => b.outcome), ["Superseded", "Completed", "Stopped", "Needs your decision", "Stopped"]);
  assert.equal(bars.runs[0].label, "23 Sep");
  assert.match(bars.runs[3].label, /^18 Nov \d{2}:\d{2}$/, "same-day runs carry a time");
  assert.equal(bars.runs[3].current, true);
  assert.equal(bars.runs[0].cost, 0.52);
  assert.equal(Number(bars.total.toFixed(2)), 27.01);
});

test("AC-14: no runs, no bars", async () => {
  const { runBars } = await import("../../../src/lib/research/run-bars");
  const bars = runBars([]);
  assert.deepEqual(bars.runs, []);
  assert.equal(bars.total, 0);
});
