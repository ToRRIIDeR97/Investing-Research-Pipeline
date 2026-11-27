// P1: AC-1 to AC-6, the pure run-flow model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { RUN_PHASES, phaseProgress, flowStep, runNow, runFeed, runEstimates, formatEstimate, waitingOnYou } from "../../../src/lib/research/run-flow";

const st = (key: string, status: string, completed_at: string | null = null, started_at: string | null = null) => ({ key, status, completed_at, started_at });

test("AC-1: five phases cover every stage once, in order, with the gates", () => {
  assert.deepEqual(RUN_PHASES.map((p) => p.label), ["Frame", "Gather", "Understand", "Value", "Decide"]);
  const keys = RUN_PHASES.flatMap((p) => p.stages);
  assert.deepEqual(keys, STAGE_CONFIGS.map((s) => s.key));
  const frame = RUN_PHASES[0], decide = RUN_PHASES[4];
  assert.ok(frame.stages.includes("research_plan")); assert.equal(frame.gate, "plan");
  assert.ok(decide.stages.includes("human_review")); assert.equal(decide.gate, "review");
  assert.equal(RUN_PHASES.filter((p) => p.gate).length, 2);
});

test("AC-2: phase progress counts done and skipped, and reads the right state", () => {
  const stages = [st("intake", "completed"), st("asset_identity", "completed"), st("archetype_composition", "completed"), st("research_plan", "completed"),
    st("source_discovery", "completed"), st("source_ingestion", "running"), st("evidence_extraction", "pending"), st("historical_record", "pending"),
    st("backtest_execution", "skipped"), st("not_a_stage", "failed")];
  const p = phaseProgress(stages);
  assert.equal(p.length, 5);
  assert.deepEqual([p[0].done, p[0].total, p[0].state], [4, 4, "done"]);
  assert.deepEqual([p[1].done, p[1].total, p[1].state], [1, 4, "active"]);
  assert.deepEqual([p[2].total, p[2].state], [0, "pending"]);
  assert.deepEqual([p[3].done, p[3].total], [1, 1]);
});

test("AC-2: waiting and failed win over active", () => {
  assert.equal(phaseProgress([st("intake", "completed"), st("research_plan", "waiting_for_human")])[0].state, "waiting");
  assert.equal(phaseProgress([st("source_discovery", "running"), st("source_ingestion", "failed")])[1].state, "failed");
});

test("AC-3: flow step follows the run", () => {
  assert.deepEqual(flowStep({ hasRun: false, status: null, stages: [] }), { index: 1, key: "question" });
  assert.equal(flowStep({ hasRun: true, status: "running", stages: [st("intake", "running"), st("research_plan", "pending")] }).key, "plan");
  assert.equal(flowStep({ hasRun: true, status: "waiting_for_human", stages: [st("research_plan", "waiting_for_human")] }).key, "plan");
  assert.equal(flowStep({ hasRun: true, status: "running", stages: [st("research_plan", "completed"), st("moat_analysis", "running")] }).key, "research");
  assert.deepEqual(flowStep({ hasRun: true, status: "waiting_for_human", stages: [st("research_plan", "completed"), st("human_review", "waiting_for_human")] }), { index: 4, key: "review" });
  assert.equal(flowStep({ hasRun: true, status: "completed", stages: [st("research_plan", "completed")] }).key, "review");
});

test("AC-4: plain words for now and the feed, newest first, no raw keys", () => {
  const stages = [st("research_plan", "completed", "2026-11-27T09:13:00Z"), st("company_genesis", "completed", "2026-11-27T09:26:00Z"), st("moat_analysis", "running", null, "2026-11-27T09:30:00Z")];
  const now = runNow(stages);
  assert.ok(now && now.length > 10); assert.doesNotMatch(now!, /_/);
  const feed = runFeed(stages);
  assert.equal(feed.length, 3);
  assert.equal(feed[0].now, true);
  assert.ok(feed[1].at! > feed[2].at!);
  for (const item of feed) { assert.doesNotMatch(item.text, /_|moat_analysis|company_genesis/); }
  assert.deepEqual(runFeed([]), []);
  assert.equal(runNow([st("intake", "completed")]), null);
});

test("AC-5: estimates are medians of machine time, the plan wait left out", () => {
  const row = (cost: string, created: string, ps: string, pc: string, rc: string | null, run_type = "deep_dive") =>
    ({ run_type, actual_cost_usd: cost, created_at: created, plan_started_at: ps, plan_completed_at: pc, review_completed_at: rc });
  const e = runEstimates([
    row("1.00", "2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z", "2026-01-01T05:00:00Z", "2026-01-01T06:00:00Z"),
    row("3.00", "2026-01-02T00:00:00Z", "2026-01-02T00:02:00Z", "2026-01-02T00:10:00Z", "2026-01-02T02:10:00Z"),
    row("9.00", "2026-01-03T00:00:00Z", "2026-01-03T00:02:00Z", "2026-01-03T00:10:00Z", null),
  ]);
  assert.equal(e.deep_dive.runs, 2);
  assert.equal(e.deep_dive.medianCostUsd, 2);
  assert.equal(e.deep_dive.medianMinutes, 92);
  assert.match(formatEstimate(undefined), /No past runs of this type yet/);
  const text = formatEstimate(e.deep_dive);
  assert.match(text, /2 past runs/); assert.match(text, /\$2\.00/); assert.match(text, /1 h 32 min/);
});

test("AC-6: Waiting on you lists reviews first, then plan approvals, once each", () => {
  const queue = [{ run_id: "r1", asset_id: "a1", asset_name: "Meta" }];
  const assets = [
    { id: "a2", canonical_name: "SoFi", ticker: "SOFI", latest_run: { id: "r2", status: "waiting_for_human", waiting_stage_key: "research_plan" } },
    { id: "a3", canonical_name: "Nu", ticker: "NU", latest_run: { id: "r3", status: "running", waiting_stage_key: null } },
  ];
  const items = waitingOnYou(queue, assets);
  assert.deepEqual(items.map((i) => [i.kind, i.run_id, i.href]), [["review", "r1", "/review?run=r1"], ["plan", "r2", "/assets/a2/run?run=r2"]]);
});
