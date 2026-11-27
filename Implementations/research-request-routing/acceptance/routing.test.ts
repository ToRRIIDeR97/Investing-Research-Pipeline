// Pure routing rules: system answers (AC-1, AC-2), stage roots (AC-5), reset planning (AC-6), next round (AC-8).
import test from "node:test";
import assert from "node:assert/strict";
import { dependentStages } from "../../../src/lib/research/team-plan";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { exported, fredCsv, loadEnv, MARKET_HISTORY, REQUEST_1_2, REQUEST_1_3, REQUEST_1_4, REQUEST_1_5, RISK_FREE, TAIL, TEAM } from "./fixtures";

loadEnv();
const marketHistory = { id: "artifact-market-history-4", content: MARKET_HISTORY };
const fred = { sourceId: "source-fred-dgs10", csv: fredCsv("8f0c2a51-0000-4000-8000-000000000000") };
const completed = STAGE_CONFIGS.map(s => ({ stage_key: s.key, status: "completed" }));
const rerun = (request: Record<string, unknown>, artifact: string) => ({ ...request,
  response: { status: "answered", answer: "The owner's artifact must be recomputed from the corrected inputs.", evidence_ids: [], artifact_ids: [artifact], requires_rerun: true } });
// pipeline-simplification: only code's rework requests (rework_stage, with code's requires_rerun answer) rerun a stage;
// an owner's requires_rerun (rerun above) reruns nothing.
const rework = (request: Record<string, unknown>, stage: string) => ({ ...request, rework_stage: stage,
  response: { status: "answered", answer: `Code sent ${stage} back for rework.`, evidence_ids: [], artifact_ids: [], resolved_by: "system:rework", requires_rerun: true } });
const sorted = (values: string[]) => [...values].sort();

test("AC-1: the 1d427f3f price-history request is answered from the stored market_price_history artifact", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const answer = systemAnswer(REQUEST_1_3, { marketHistory, fred });
  assert.equal(answer?.status, "answered");
  assert.equal(answer.resolved_by, "system:market-history", "market history is checked before FRED");
  assert.deepEqual(answer.artifact_ids, [marketHistory.id]);
  assert.deepEqual(answer.evidence_ids, []);
  assert.match(answer.answer, /1,?506/, "bars available");
  assert.match(answer.answer, /2026-10-09/, "last trading day");
  assert.match(answer.answer, /\b27\b/, "unverified period count");
  assert.match(answer.answer, /unverified/i, "verification status");
});

test("AC-1: without a market_price_history artifact the market request is not answered from market history", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  assert.equal(systemAnswer(REQUEST_1_3, {}) ?? null, null);
  // The same question names DGS10, so the FRED series answers it when that is the only fact on hand.
  assert.equal(systemAnswer(REQUEST_1_3, { fred })?.resolved_by, "system:fred");
});

test("AC-2: a 10-year Treasury request is answered from the run's FRED DGS10 document", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const answer = systemAnswer(RISK_FREE, { marketHistory, fred });
  assert.equal(answer?.status, "answered");
  assert.equal(answer.resolved_by, "system:fred");
  assert.deepEqual(answer.source_ids, [fred.sourceId]);
  assert.match(answer.answer, /5\.22/, "latest value");
  assert.match(answer.answer, /2026-10-08/, "its observation date");
});

test("AC-2: requests the system cannot answer are left to the owner", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  assert.equal(systemAnswer(REQUEST_1_2, { marketHistory, fred }) ?? null, null);
  assert.equal(systemAnswer(RISK_FREE, { marketHistory }) ?? null, null);
});

test("AC-2: source_ids count as support and are kept only for the run's documents", () => {
  const keepCurrentReferences = exported(TEAM, "keepCurrentReferences");
  const kept = keepCurrentReferences({ status: "answered", answer: "DGS10 was 5.22 on 2026-10-08.", evidence_ids: [], artifact_ids: [],
    source_ids: ["source-fred-dgs10", "source-from-another-run"] }, { evidence: [], artifacts: [], sources: [{ id: "source-fred-dgs10" }] });
  assert.deepEqual(kept.source_ids, ["source-fred-dgs10"]);
});

test("AC-5: data and source requests never reopen source_discovery; only code's rework names a root (pipeline-simplification)", () => {
  const requestStageRoots = exported(TEAM, "requestStageRoots");
  assert.deepEqual(requestStageRoots([REQUEST_1_3]), [], "an unanswered data request");
  assert.deepEqual(requestStageRoots([{ ...REQUEST_1_4, needs_sources: true }]), [], "an unanswered request that needs sources");
  assert.deepEqual(requestStageRoots([rerun(REQUEST_1_3, "a0")]), [], "role data contributes no root");
  const answered = { ...REQUEST_1_2, response: { status: "answered", answer: "Verified.", evidence_ids: ["e1"], artifact_ids: [] } };
  // pipeline-simplification: an owner's requires_rerun names no root (was ["asset_valuation"]); code's rework does.
  assert.deepEqual(requestStageRoots([answered, rerun(REQUEST_1_4, "a1"), rerun(REQUEST_1_3, "a0")]), []);
  assert.deepEqual(requestStageRoots([answered, rework(REQUEST_1_4, "asset_valuation"), rerun(REQUEST_1_3, "a0")]), ["asset_valuation"]);
});

// Counts follow architecture-9 P1: the backtests depend only on the plan, so analysis re-runs leave them alone.
test("AC-6: the first valuation re-run (2 analysis stages) is planned as automatic", () => {
  const requestResetPlan = exported(TEAM, "requestResetPlan");
  // pipeline-simplification: the rerun now comes from code's rework (was the owner's requires_rerun).
  const plan = requestResetPlan([rework(REQUEST_1_4, "asset_valuation")], completed, { autoResetUsed: false });
  assert.equal(plan.mode, "auto");
  assert.deepEqual(sorted(plan.stages), sorted(dependentStages(["asset_valuation"])));
  assert.equal(plan.analysis_stages.length, 2);
  assert.ok(plan.analysis_stages.every((key: string) => !TAIL.includes(key)));
  assert.deepEqual(plan.request_ids, ["request-1-4"]);
});

// pipeline-simplification: nothing waits for approval. A reset over the limit, or after the automatic one, is "none" and
// its rework requests are declined (was mode "approval" with the stages listed).
test("AC-6: a financials re-run (9 analysis stages) or a second automatic reset reruns nothing and is declined", () => {
  const requestResetPlan = exported(TEAM, "requestResetPlan");
  const financials = requestResetPlan([rework(REQUEST_1_2, "historical_record")], completed, { autoResetUsed: false });
  assert.equal(financials.mode, "none");
  // Genesis, business and moat read the financial_analytics digest, so they would re-run with the record: 9 stages.
  assert.match(financials.declined.reason, /9 analysis stages, over the automatic limit of 6/);
  assert.deepEqual(financials.declined.request_ids, ["request-1-2"]);
  const used = requestResetPlan([rework(REQUEST_1_4, "asset_valuation")], completed, { autoResetUsed: true });
  assert.equal(used.mode, "none");
  assert.match(used.declined.reason, /already used/);
  assert.equal(requestResetPlan([rerun(REQUEST_1_4, "a1")], completed, { autoResetUsed: false }).mode, "none", "an owner's flag reruns nothing");
});

test("AC-6: answers without requires_rerun reset nothing", () => {
  const requestResetPlan = exported(TEAM, "requestResetPlan");
  const answered = { ...REQUEST_1_4, response: { status: "answered", answer: "Reconciled.", evidence_ids: [], artifact_ids: ["a1"] } };
  const plan = requestResetPlan([answered, REQUEST_1_3], completed, { autoResetUsed: false });
  assert.equal(plan.mode, "none");
  assert.deepEqual(plan.stages, []);
  assert.deepEqual(plan.request_ids, []);
});

// pipeline-simplification: one round per run, so there is no next round to carry source_escalated into (was: round 2
// inherited it, and a third round was refused).
test("AC-8: after the run's one round no next round is created, so an escalation can't be used again", () => {
  const nextRequestBatch = exported(TEAM, "nextRequestBatch");
  const unavailable = { status: "unavailable", answer: "Not in the corpus.", evidence_ids: [], artifact_ids: [] };
  const round1 = { round: 1, state: "answered", source_escalated: true, requests: [{ ...REQUEST_1_5, response: unavailable }] };
  const { id: _id, ...repeat } = REQUEST_1_5;
  const fresh = { role: "financials", question: "Which Reality Labs cost lines are disclosed for each quarter of 2026?", material: true,
    needs_sources: false, source_role: "regulatory_filing" };
  assert.equal(nextRequestBatch(round1, [{ ...repeat, question: `  ${REQUEST_1_5.question.toUpperCase()} ` }, fresh]) ?? null, null);
  const first = nextRequestBatch(null, [fresh]);
  assert.equal(first?.round, 1);
  assert.equal(first.state, "queued");
  assert.equal(first.source_escalated, undefined, "the first round starts unescalated");
  assert.deepEqual(first.requests.map((r: any) => r.id), ["request-1-1"]);
});
