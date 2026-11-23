import { test } from "node:test";
import assert from "node:assert/strict";
import { runBars } from "../src/lib/research/run-bars";

test("runBars: needs_more_work is a stopped run; only waiting_for_human waits and the newest one is current", () => {
  const { runs } = runBars([
    { id: "b", created_at: "2026-10-02T09:00:00Z", status: "waiting_for_human", actual_cost_usd: "1.5" },
    { id: "a", created_at: "2026-10-01T09:00:00Z", status: "needs_more_work", actual_cost_usd: null },
    { id: "c", created_at: "2026-10-03T09:00:00Z", status: "running", actual_cost_usd: "abc" },
  ]);
  assert.deepEqual(runs.map((r) => [r.id, r.outcome, r.current, r.cost, r.label]), [
    ["a", "Stopped", false, 0, "1 Oct"], ["b", "Needs your decision", true, 1.5, "2 Oct"], ["c", "Researching", false, 0, "3 Oct"],
  ]);
});

test("runBars: an older run waiting for plan approval says so and never supersedes or becomes the decision", () => {
  const { runs } = runBars([
    { id: "p", created_at: "2026-11-01T09:00:00Z", status: "waiting_for_human", waiting_stage_key: "research_plan", actual_cost_usd: "0.2" },
    { id: "d", created_at: "2026-11-05T09:00:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", actual_cost_usd: "4" },
    { id: "q", created_at: "2026-11-09T09:00:00Z", status: "waiting_for_human", waiting_stage_key: "research_plan", actual_cost_usd: "0.1" },
  ]);
  assert.deepEqual(runs.map((r) => [r.id, r.outcome, r.current]), [
    ["p", "Needs plan approval", false], ["d", "Needs your decision", true], ["q", "Needs plan approval", false],
  ]);
});

test("runBars: unknown statuses read as words and a lone run on a day has no time", () => {
  const { runs, total } = runBars([{ id: "x", created_at: "2026-01-05T23:59:00Z", status: "paused_by_user", actual_cost_usd: 2 }], { timeZone: "UTC" });
  assert.deepEqual(runs[0], { id: "x", label: "5 Jan", outcome: "Paused by user", cost: 2, current: false });
  assert.equal(total, 2);
});

test("runBars: a final decision reads Decided and hands current to the next waiting run; a send-back changes nothing", () => {
  const { runs } = runBars([
    { id: "old", created_at: "2026-11-01T09:00:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: null },
    { id: "w", created_at: "2026-11-05T09:00:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: "reject" },
    { id: "s", created_at: "2026-11-09T09:00:00Z", status: "waiting_for_human", waiting_stage_key: "human_review", latest_decision: "needs_more_work" },
  ], { timeZone: "UTC" });
  assert.deepEqual(runs.map((r) => [r.id, r.outcome, r.current]), [
    ["old", "Superseded", false], ["w", "Decided", false], ["s", "Needs your decision", true],
  ]);
});

test("runBars: same-day detection follows the zone", () => {
  const rows = [
    { id: "a", created_at: "2026-11-18T15:00:00Z", status: "completed" },
    { id: "b", created_at: "2026-11-18T17:00:00Z", status: "completed" },
  ];
  assert.deepEqual(runBars(rows, { timeZone: "UTC" }).runs.map((r) => r.label), ["18 Nov 15:00", "18 Nov 17:00"]);
  assert.deepEqual(runBars(rows, { timeZone: "Asia/Singapore" }).runs.map((r) => r.label), ["18 Nov", "19 Nov"]);
});
