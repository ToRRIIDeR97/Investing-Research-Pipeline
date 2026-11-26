// Worker-visible acceptance tests for Implementations/pipeline-simplification (AC-3, AC-4, AC-5, AC-6, AC-7).
// Run: npx tsx --test Implementations/pipeline-simplification/acceptance/request-rounds.test.ts
// Expectations come from implementation.md, not from the implementation. Don't weaken or skip them.
import test from "node:test";
import assert from "node:assert/strict";
import { nextRequestBatch, requestResetPlan, reworkAnswer, reworkRequests, type TeamRequest } from "../../../src/lib/research/team";

const ask = (id: string, role: string, question: string, extra: Record<string, unknown> = {}) =>
  ({ id, role, question, material: true, needs_sources: false, source_role: "regulatory_filing", ...extra }) as unknown as TeamRequest;
const stages = ["historical_record", "operating_scenarios", "asset_valuation", "decision_synthesis", "report_draft", "ai_reviewer", "human_review", "export", "refresh_schedule"]
  .map(stage_key => ({ stage_key, status: "completed" }));
const proposal = [{ role: "financials", question: "Restate Q3 2026 segment income.", material: true, needs_sources: false, source_role: "regulatory_filing" }] as any[];

// ---------- AC-4: one pre-draft round ----------

test("AC-4: the first pre-draft proposal opens round 1", () => {
  const batch = nextRequestBatch(null, proposal, "pre_draft");
  assert.ok(batch, "a first round is created");
  assert.equal(batch!.round, 1);
});

test("AC-4: after one pre-draft round, no further pre-draft round is created", () => {
  const first = nextRequestBatch(null, proposal, "pre_draft")!;
  const answered = { ...first, state: "answered" as const, requests: first.requests.map(r => ({ ...r, response: { status: "answered", answer: "Done.", evidence_ids: [], artifact_ids: ["a1"] } })) };
  assert.equal(nextRequestBatch(answered as any, [{ ...proposal[0], question: "Another question." }], "pre_draft"), null);
});

// ---------- AC-3: no post-review round ----------

test("AC-3: asking for a post-review round never creates one", () => {
  const first = nextRequestBatch(null, proposal, "pre_draft")!;
  const answered = { ...first, state: "answered" as const };
  const after = nextRequestBatch(answered as any, [{ ...proposal[0], question: "Post-review question." }], "post_review" as any);
  assert.ok(after === null || !(after as any).post_review_round, "no batch carries post_review_round");
  const fresh = nextRequestBatch(null, proposal, "post_review" as any);
  assert.ok(fresh === null || !(fresh as any).post_review_round, "not even as the run's first round");
});

// ---------- AC-5 / AC-6 / AC-7: who can rerun a stage ----------

const ownerRerun = () => ask("request-1-2", "valuation", "Recheck the valuation.",
  { response: { status: "answered", answer: "The 2026 tax rate is wrong.", evidence_ids: [], artifact_ids: ["a1"], requires_rerun: true } });
const codeRework = () => {
  const [rework] = reworkRequests([{ category: "analysis_rework", owner_stage: "asset_valuation", issue: "The valuation failed code's plausibility check." }]);
  const request = { ...rework, id: "request-1-1" } as TeamRequest;
  return { ...request, response: reworkAnswer(request) } as TeamRequest;
};

test("AC-5: an owner's requires_rerun alone reruns nothing", () => {
  const plan = requestResetPlan([ownerRerun()], stages, { autoResetUsed: false });
  assert.equal(plan.mode, "none");
  assert.deepEqual(plan.stages, []);
});

test("AC-6: the valuation check's rework reruns asset_valuation automatically when the run's automatic rerun is unused", () => {
  const plan = requestResetPlan([codeRework(), ownerRerun()], stages, { autoResetUsed: false });
  assert.equal(plan.mode, "auto");
  assert.ok(plan.stages.includes("asset_valuation"));
  assert.deepEqual(plan.request_ids, ["request-1-1"], "only the code's rework is a rerun request");
});

test("AC-6, AC-7: once the automatic rerun is used, the rework gives none, never approval", () => {
  assert.equal(requestResetPlan([codeRework()], stages, { autoResetUsed: true }).mode, "none");
});

test("AC-7: a rework past the automatic stage limit gives none, never approval", () => {
  assert.equal(requestResetPlan([codeRework()], stages, { autoResetUsed: false, maxAutoStages: 0 }).mode, "none");
});
