import { test } from "node:test";
import assert from "node:assert/strict";
import { runBars } from "../src/lib/research/run-bars";

test("runBars: waiting_for_human waits like needs_more_work, only the newest waiting run is current", () => {
  const { runs } = runBars([
    { id: "b", created_at: "2026-10-02T09:00:00Z", status: "waiting_for_human", actual_cost_usd: "1.5" },
    { id: "a", created_at: "2026-10-01T09:00:00Z", status: "needs_more_work", actual_cost_usd: null },
    { id: "c", created_at: "2026-10-03T09:00:00Z", status: "running", actual_cost_usd: "abc" },
  ]);
  assert.deepEqual(runs.map((r) => [r.id, r.outcome, r.current, r.cost, r.label]), [
    ["a", "Superseded", false, 0, "1 Oct"], ["b", "Needs your decision", true, 1.5, "2 Oct"], ["c", "Researching", false, 0, "3 Oct"],
  ]);
});

test("runBars: unknown statuses read as words and a lone run on a day has no time", () => {
  const { runs, total } = runBars([{ id: "x", created_at: "2026-01-05T23:59:00Z", status: "paused_by_user", actual_cost_usd: 2 }]);
  assert.deepEqual(runs[0], { id: "x", label: "5 Jan", outcome: "Paused by user", cost: 2, current: false });
  assert.equal(total, 2);
});
