// Independent boundary checks of the pure routing contract (AC-1, AC-2, AC-5, AC-6, AC-8).
import test from "node:test";
import assert from "node:assert/strict";
import { dependentStages } from "../../../src/lib/research/team-plan";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { exported, fredWithTrailingBlank, loadEnv, TAIL, TEAM, VERIFIED_HISTORY } from "./fixtures";

loadEnv();
const request = (id: string, role: string, source_role: string, question: string, needs_sources = false) =>
  ({ id, role, source_role, question, material: true, needs_sources });
const rerun = (r: Record<string, unknown>) => ({ ...r, response: { status: "answered", answer: "Inputs changed; recompute.",
  evidence_ids: ["e1"], artifact_ids: [], requires_rerun: true } });
const ledger = (skipped: string[] = []) => STAGE_CONFIGS.map(s => ({ stage_key: s.key, status: skipped.includes(s.key) ? "skipped" : "completed" }));
const sorted = (values: string[]) => [...values].sort();
const history = { id: "market-history-v2", content: VERIFIED_HISTORY };
const fred = { sourceId: "fred-dgs10-verify", csv: fredWithTrailingBlank("a1b2c3d4") };

test("AC-1: a data request about market capitalization is answered from a fully verified history", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const answer = systemAnswer(request("request-1-1", "data", "regulatory_filing", "What was the market capitalization at each quarter end through 2026-09-30?"), { marketHistory: history });
  assert.equal(answer?.resolved_by, "system:market-history");
  assert.deepEqual(answer.artifact_ids, [history.id]);
  assert.match(answer.answer, /1,?012/);
  assert.match(answer.answer, /2026-09-30/);
  assert.match(answer.answer, /\b20\b/);
  assert.match(answer.answer, /verified/i);
});

test("AC-1: only role data asks about prices by question; other roles need source_role market_data", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const pricing = request("request-1-2", "business", "company_investor_relations", "How much pricing power did the price increases in 2025 demonstrate?");
  assert.equal(systemAnswer(pricing, { marketHistory: history }) ?? null, null);
  const byRole = request("request-1-3", "valuation", "market_data", "Which closing level anchors the valuation date?");
  assert.equal(systemAnswer(byRole, { marketHistory: history })?.resolved_by, "system:market-history");
});

test("AC-1: a market_price_history artifact without stored bars does not answer the request", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const empty = { id: "market-history-empty", content: { ...VERIFIED_HISTORY, bars_available: 0, first_trading_day: null, last_trading_day: null,
    cross_check: { provider: "stooq", tolerance_pct: 0.5, verified_periods: 0, unverified_periods: 0 }, gap: "No stored daily prices for VHQA by the market-data cutoff." } };
  assert.equal(systemAnswer(request("request-1-4", "data", "market_data", "Provide the daily price history through 2026-09-30."), { marketHistory: empty }) ?? null, null);
});

test("AC-2: the latest non-blank FRED observation is used when the series ends on a holiday blank", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const answer = systemAnswer(request("request-2-1", "valuation", "regulatory_filing", "Which risk-free rate supports the 9.5% discount rate?"), { fred });
  assert.equal(answer?.resolved_by, "system:fred", "the question names the risk-free rate");
  assert.deepEqual(answer.source_ids, [fred.sourceId]);
  assert.match(answer.answer, /4\.12/);
  assert.match(answer.answer, /2026-10-09/);
});

test("AC-2: a FRED document with no values, or no FRED document, leaves the request to the owner", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const blank = { sourceId: "fred-blank", csv: "observation_date,DGS10\n2026-10-12,\n2026-10-13," };
  const ask = request("request-2-2", "valuation", "macro_dataset", "What is the 10-year Treasury yield at the valuation date?");
  assert.equal(systemAnswer(ask, { fred: blank }) ?? null, null);
  assert.equal(systemAnswer(ask, { marketHistory: history }) ?? null, null);
});

test("AC-2: the question decides, not the source role: inflation gets no FRED answer, a discount-rate question does", () => {
  const systemAnswer = exported(TEAM, "systemAnswer");
  const inflation = request("request-2-3", "valuation", "macro_dataset", "What was Brazil's 12-month IPCA inflation rate in August 2026?");
  assert.equal(systemAnswer(inflation, { fred, marketHistory: history }) ?? null, null);
  const discount = request("request-2-4", "valuation", "earnings_release", "Which discount rate does the valuation use?");
  assert.equal(systemAnswer(discount, { fred })?.resolved_by, "system:fred");
  const yieldAsk = request("request-2-5", "financials", "regulatory_filing", "What was the treasury yield on the last observation?");
  assert.equal(systemAnswer(yieldAsk, { fred })?.resolved_by, "system:fred");
});

test("AC-5: no role, with or without needs_sources, maps to source_discovery", () => {
  const requestStageRoots = exported(TEAM, "requestStageRoots");
  for (const role of ["data", "financials", "business", "valuation"]) for (const needs of [true, false]) {
    const plain = request(`request-${role}`, role, "regulatory_filing", `Question routed to ${role} specialist`, needs);
    assert.ok(!requestStageRoots([plain]).includes("source_discovery"), `${role} unanswered, needs_sources ${needs}`);
    assert.ok(!requestStageRoots([rerun(plain)]).includes("source_discovery"), `${role} requires_rerun, needs_sources ${needs}`);
  }
  const roots = requestStageRoots([rerun(request("r1", "business", "proxy_and_governance", "Rebuild the management history", true)),
    rerun(request("r2", "data", "market_data", "Refetch prices for the valuation date"))]);
  assert.deepEqual(roots, ["company_genesis"]);
});

test("AC-6: the automatic limit is inclusive and configurable", () => {
  const requestResetPlan = exported(TEAM, "requestResetPlan");
  const valuation = [rerun(request("r1", "valuation", "regulatory_filing", "Recompute the discounting base date"))];
  assert.equal(requestResetPlan(valuation, ledger(), { autoResetUsed: false, maxAutoStages: 6 }).mode, "auto", "6 of 6");
  assert.equal(requestResetPlan(valuation, ledger(), { autoResetUsed: false, maxAutoStages: 5 }).mode, "approval", "6 of 5");
  const financials = [rerun(request("r2", "financials", "regulatory_filing", "Recapture the Q3 2025 cash flow quarter"))];
  process.env.RESEARCH_MAX_AUTO_RESET_STAGES = "10";
  try { assert.equal(requestResetPlan(financials, ledger(), { autoResetUsed: false }).mode, "auto", "10 of 10 from the environment"); }
  finally { delete process.env.RESEARCH_MAX_AUTO_RESET_STAGES; }
  assert.equal(requestResetPlan(financials, ledger(), { autoResetUsed: false }).mode, "approval", "default limit 6");
});

test("AC-6: skipped stages are neither reset nor counted", () => {
  const requestResetPlan = exported(TEAM, "requestResetPlan");
  const skipped = ["indicator_design", "strategy_design", "backtest_execution", "backtest_review", "moat_analysis"];
  const business = [rerun(request("r3", "business", "company_investor_relations", "Rebuild the operating history"))];
  const plan = requestResetPlan(business, ledger(skipped), { autoResetUsed: false });
  assert.deepEqual(sorted(plan.analysis_stages), sorted(dependentStages(["company_genesis"]).filter(k => !TAIL.includes(k) && !skipped.includes(k))));
  assert.equal(plan.analysis_stages.length, 6);
  assert.equal(plan.mode, "auto");
  assert.ok(plan.stages.every((key: string) => !skipped.includes(key)));
  assert.ok(TAIL.every(key => plan.stages.includes(key)), "the tail is reset but not counted");
});

test("AC-6: several owners reset the union of their stages; a used automatic reset always needs approval", () => {
  const requestResetPlan = exported(TEAM, "requestResetPlan");
  const both = [rerun(request("r4", "valuation", "regulatory_filing", "Recompute the valuation schedule")),
    { ...request("r5", "business", "proxy_and_governance", "Who reports to the CEO?"), response: { status: "answered", answer: "Documented.", evidence_ids: ["e2"], artifact_ids: [] } },
    rerun(request("r6", "financials", "regulatory_filing", "Recapture restated revenue"))];
  const plan = requestResetPlan(both, ledger(), { autoResetUsed: false });
  assert.deepEqual(sorted(plan.stages), sorted([...new Set([...dependentStages(["asset_valuation"]), ...dependentStages(["historical_record"])])]));
  assert.deepEqual(sorted(plan.request_ids), ["r4", "r6"]);
  assert.equal(plan.mode, "approval");
  const small = requestResetPlan([both[0]], ledger(["indicator_design", "strategy_design", "backtest_execution", "backtest_review", "decision_synthesis"]),
    { autoResetUsed: true, maxAutoStages: 6 });
  assert.equal(small.analysis_stages.length, 1);
  assert.equal(small.mode, "approval");
});

test("AC-8: the first round starts unescalated; a later round inherits false as false", () => {
  const nextRequestBatch = exported(TEAM, "nextRequestBatch");
  const ask = { role: "valuation", question: "What maintenance capex is disclosed separately?", material: true, needs_sources: false, source_role: "regulatory_filing" };
  const first = nextRequestBatch(null, [ask, { ...ask, question: "what maintenance capex is disclosed separately?" }]);
  assert.equal(first?.round, 1);
  assert.equal(first.state, "queued");
  assert.ok(!first.source_escalated);
  assert.deepEqual(first.requests.map((r: any) => r.id), ["request-1-1"], "a repeat within one output is dropped");
  const second = nextRequestBatch({ ...first, state: "answered", source_escalated: false }, [{ ...ask, question: "Which lease costs are capitalised?" }]);
  assert.equal(second?.round, 2);
  assert.ok(!second.source_escalated);
  assert.equal(nextRequestBatch({ ...first, state: "answered" }, [{ ...ask, question: "  WHAT MAINTENANCE CAPEX IS DISCLOSED SEPARATELY? " }]) ?? null, null,
    "only repeated questions: no new round");
});
