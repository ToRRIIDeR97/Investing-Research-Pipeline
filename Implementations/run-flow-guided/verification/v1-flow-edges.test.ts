// Verification: edge cases of the same contract (AC-1 to AC-6), different fixtures from acceptance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_CONFIGS, getAllStagesForRun } from "../../../src/lib/workflow/stages";
import { RUN_PHASES, phaseProgress, flowStep, runNow, runFeed, runEstimates, formatEstimate, waitingOnYou } from "../../../src/lib/research/run-flow";

const all = (status: string) => STAGE_CONFIGS.map((s) => ({ key: s.key, status }));

test("AC-1: no stage key is shared between phases and each phase has stages", () => {
  const seen = new Set<string>();
  for (const p of RUN_PHASES) { assert.ok(p.stages.length > 0); for (const k of p.stages) { assert.ok(!seen.has(k), k); seen.add(k); } }
  assert.equal(seen.size, STAGE_CONFIGS.length);
});

test("AC-2: a finished run reads all done; a fresh one all pending", () => {
  assert.ok(phaseProgress(all("completed")).every((p) => p.state === "done" && p.done === p.total && p.total > 0));
  assert.ok(phaseProgress(all("pending")).every((p) => p.state === "pending" && p.done === 0));
  assert.ok(phaseProgress([]).every((p) => p.state === "pending" && p.total === 0));
});

test("AC-2: a quick scan's skipped backtests count as done", () => {
  const { skipped } = getAllStagesForRun("quick_scan");
  const stages = STAGE_CONFIGS.map((s) => ({ key: s.key, status: skipped.some((k) => k.key === s.key) ? "skipped" : "completed" }));
  assert.ok(phaseProgress(stages).every((p) => p.state === "done"));
});

test("AC-2: partly done with nothing running reads active, not pending", () => {
  const p = phaseProgress([{ key: "source_discovery", status: "completed" }, { key: "source_ingestion", status: "pending" }]);
  assert.equal(p[1].state, "active");
});

test("AC-3: stopped runs after the plan stay on research; before it, on plan", () => {
  assert.equal(flowStep({ hasRun: true, status: "failed", stages: [{ key: "research_plan", status: "completed" }, { key: "moat_analysis", status: "failed" }] }).key, "research");
  assert.equal(flowStep({ hasRun: true, status: "cancelled", stages: [{ key: "research_plan", status: "completed" }] }).key, "research");
  assert.equal(flowStep({ hasRun: true, status: "needs_more_work", stages: [{ key: "intake", status: "failed" }, { key: "research_plan", status: "pending" }] }).key, "plan");
  assert.equal(flowStep({ hasRun: true, status: "approved", stages: [{ key: "research_plan", status: "completed" }] }).index, 4);
});

test("AC-4: every stage has its own plain sentence, and queued stands in for running", () => {
  const sentences = new Set<string>();
  for (const s of STAGE_CONFIGS) {
    const text = runNow([{ key: s.key, status: "running" }]);
    assert.ok(text, s.key); assert.doesNotMatch(text!, /_/); sentences.add(text!);
  }
  assert.equal(sentences.size, STAGE_CONFIGS.length);
  assert.ok(runNow([{ key: "export", status: "queued" }]));
});

test("AC-4: feed items without a time keep a stable place and skip pending stages", () => {
  const feed = runFeed([{ key: "intake", status: "completed", completed_at: null }, { key: "asset_identity", status: "pending" }, { key: "source_discovery", status: "completed", completed_at: "2026-11-01T10:00:00Z" }]);
  assert.equal(feed.length, 2);
  assert.ok(feed.every((i) => !i.now));
  assert.equal(feed[0].at, "2026-11-01T10:00:00Z");
});

test("AC-5: odd counts take the middle value; numeric strings and Dates are accepted", () => {
  const mk = (cost: string | number, minutesAfterPlan: number, run_type = "full_initiation_report") => ({
    run_type, actual_cost_usd: cost, created_at: new Date("2026-02-01T00:00:00Z"), plan_started_at: new Date("2026-02-01T00:00:00Z"),
    plan_completed_at: new Date("2026-02-01T01:00:00Z"), review_completed_at: new Date(Date.parse("2026-02-01T01:00:00Z") + minutesAfterPlan * 60_000),
  });
  const e = runEstimates([mk("0.50", 30), mk(4.86, 300), mk("1.72", 45), mk("2", 20, "quick_scan")]);
  assert.equal(e.full_initiation_report.runs, 3);
  assert.equal(e.full_initiation_report.medianCostUsd, 1.72);
  assert.equal(e.full_initiation_report.medianMinutes, 45);
  assert.equal(e.quick_scan.runs, 1);
  assert.match(formatEstimate(e.full_initiation_report), /3 past runs[\s\S]*\$1\.72[\s\S]*45 min/);
  assert.match(formatEstimate(e.quick_scan), /1 past run\b/);
});

test("AC-5: negative or missing times are left out; nothing left means no entry", () => {
  const e = runEstimates([
    { run_type: "deep_dive", actual_cost_usd: "1", created_at: "2026-01-01T00:00:00Z", plan_started_at: "2026-01-01T00:00:00Z", plan_completed_at: "2026-01-01T02:00:00Z", review_completed_at: "2026-01-01T01:00:00Z" },
    { run_type: "deep_dive", actual_cost_usd: "1", created_at: "2026-01-01T00:00:00Z", plan_started_at: null, plan_completed_at: "2026-01-01T02:00:00Z", review_completed_at: "2026-01-01T03:00:00Z" },
  ]);
  assert.equal(e.deep_dive, undefined);
  assert.deepEqual(runEstimates([]), {});
});

test("AC-6: a run already in the review queue is not listed twice; empty inputs give nothing", () => {
  const items = waitingOnYou(
    [{ run_id: "r2", asset_id: "a2", asset_name: "SoFi" }],
    [{ id: "a2", canonical_name: "SoFi", ticker: "SOFI", latest_run: { id: "r2", status: "waiting_for_human", waiting_stage_key: "research_plan" } },
     { id: "a4", canonical_name: "Ally", ticker: "ALLY", latest_run: { id: "r4", status: "waiting_for_human", waiting_stage_key: "human_review" } },
     { id: "a5", canonical_name: "None", ticker: null, latest_run: null }],
  );
  assert.deepEqual(items.map((i) => i.run_id), ["r2"]);
  assert.deepEqual(waitingOnYou([], []), []);
});
