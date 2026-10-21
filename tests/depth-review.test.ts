import test from "node:test";
import assert from "node:assert/strict";
import { DEPTH_CHECKS, depthCheckErrors, resolveDepthChecks, deriveReview, reviewGate, valuationFlags, depthFindings } from "../src/lib/research/reporting/depth";
import { AI_REVIEWER_CONTRACT } from "../src/lib/research/stage-contracts";
import { composeReviewedReport, reconcileCoverage } from "../src/lib/research/reporting/compose";
import { checkReportSubstance } from "../src/lib/research/reporting/substance";
import { nextRequestBatch, reworkRequests, requestStageRoots, reworkAnswer, preDraftRequests, postReviewAnswers, type RequestBatch, type TeamRequest } from "../src/lib/research/team";
import { parseRubricRatings, ratingAgreement } from "../src/lib/research/scoring/rubric";

const allMet = () => DEPTH_CHECKS.map(c => ({ id: c.id, status: "met" as const, section_id: "", why: "Present." }));
const withStatus = (id: string, status: string) => allMet().map(c => c.id === id ? { ...c, status: status as any } : c);
const facts = (noRerating: number | null, tv = 0.6) => ({ id: "f1", artifact_type: "report_facts", artifact_version: 1, content_json: {
  valuation_status: "complete", market: { fcf_yield: 0.03 },
  cases: { columns: ["case", "tv_share_of_ev", "no_rerating_return"], rows: [["bear", tv, noRerating], ["base", tv, noRerating], ["bull", tv, noRerating]] } } });
const review = (extra: Record<string, unknown> = {}) => ({ review_summary: "ok", findings: [], quality_score: 0.8, recommendations: [], review_verdict: "pass", depth_checks: allMet(), ...extra });

test("the reviewer contract requires every depth check once and an owner stage on analysis_rework findings", () => {
  assert.deepEqual(AI_REVIEWER_CONTRACT.validate!(review()), []);
  const missingOne = AI_REVIEWER_CONTRACT.validate!(review({ depth_checks: allMet().slice(1) }));
  assert.match(missingOne[0].message, /decisive_insight/);
  assert.equal(depthCheckErrors([...allMet(), allMet()[0]]).length, 1, "a duplicate is an error");
  const rework = AI_REVIEWER_CONTRACT.validate!(review({ findings: [{ category: "analysis_rework", severity: "high", issue: "Redo" }] }));
  assert.match(rework[0].path, /findings\.0\.owner_stage/);
  assert.deepEqual(AI_REVIEWER_CONTRACT.validate!(review({ findings: [{ category: "analysis_rework", owner_stage: "asset_valuation" }] })), []);
});

test("code corrects the reviewer where the stored data decides availability", () => {
  const stored = resolveDepthChecks(withStatus("no_rerating_return", "data_unavailable"), [facts(0.12)]);
  assert.equal(stored.find(c => c.id === "no_rerating_return")!.status, "missing", "computed data can't be unavailable");
  const absent = resolveDepthChecks(withStatus("no_rerating_return", "missing"), [facts(null)]);
  assert.equal(absent.find(c => c.id === "no_rerating_return")!.status, "data_unavailable", "absent data can't be missing");
  const judged = resolveDepthChecks(withStatus("moat_attacks", "missing"), [facts(0.1)]);
  assert.equal(judged.find(c => c.id === "moat_attacks")!.status, "missing", "the reviewer decides where code can't");
});

test("missing decision-critical depth sends the report back; unavailable data caps it at conditional_pass", () => {
  assert.equal(deriveReview(review(), [facts(0.1)]).review_verdict, "pass");
  const missing = deriveReview(review({ depth_checks: withStatus("what_would_change_my_mind", "missing") }), [facts(0.1)]);
  assert.equal(missing.review_verdict, "needs_more_work");
  assert.equal(missing.model_verdict, "pass", "the reviewer's own verdict is kept");
  const [finding] = depthFindings(missing.depth_checks, [{ id: "summary", coverage: ["conclusion"] }, { id: "valuation", coverage: ["valuation"] }]);
  assert.deepEqual([finding.owner_stage, finding.category, finding.section_id], ["decision_synthesis", "depth_gap", "summary"],
    "a section-repair finding aimed at the chapter that owns the check's coverage");
  const unavailable = deriveReview(review({ depth_checks: withStatus("ownership_and_control", "data_unavailable") }), [facts(0.1)]);
  assert.equal(unavailable.review_verdict, "conditional_pass");
  const optional = deriveReview(review({ depth_checks: withStatus("scorecard_confidence", "missing") }), [facts(0.1)]);
  assert.equal(optional.review_verdict, "conditional_pass", "a non-critical gap does not send the report back");
  assert.equal(deriveReview({ review_verdict: "conditional_pass", findings: [] }, []).review_verdict, "conditional_pass", "a review without depth checks keeps its verdict");
});

test("unresolved critical findings and code-confirmed high calculation findings block a position, not tracking", () => {
  const artifacts = [facts(0.1, 1.03), { id: "m", artifact_type: "expected_return_matrix", artifact_version: 1, content_json: { permanent_loss_limit: -0.7, bear_return: -0.7 } }];
  assert.deepEqual(valuationFlags(artifacts).map(f => f.id), ["terminal_share_high", "permanent_loss_equals_bear"]);
  const confirmed = deriveReview(review({ review_verdict: "conditional_pass",
    findings: [{ section_id: "valuation", category: "calculation", severity: "high", issue: "Terminal value exceeds enterprise value" }] }), artifacts);
  assert.equal(confirmed.review_verdict, "conditional_pass");
  assert.equal(confirmed.effective_verdict, "needs_more_work");
  assert.match(confirmed.blocking[0].reason, /confirmed by code/);
  const unconfirmed = deriveReview(review({ findings: [{ category: "calculation", severity: "high", issue: "Revenue growth is mis-stated" }] }), artifacts);
  assert.equal(unconfirmed.effective_verdict, "pass", "a high finding code can't confirm does not block");
  const critical = deriveReview(review({ findings: [{ category: "evidence", severity: "critical", issue: "Financials deliverable incomplete" }] }), []);
  assert.equal(critical.effective_verdict, "needs_more_work");

  const gate = reviewGate({ ...review({ review_verdict: "needs_more_work", findings: confirmed.blocking }), ...confirmed });
  assert.equal(gate.trackable, true, "tracking reads the reviewer's own verdict");
  assert.equal(gate.positionable, false);
  assert.equal(reviewGate({ ...missingCritical(), review_verdict: "needs_more_work" }).trackable, true, "missing depth never deadlocks tracking");
  assert.deepEqual(reviewGate({ review_verdict: "conditional_pass", findings: [{ severity: "high" }] }),
    { trackable: true, positionable: true, blocking: [], open_severe: 1 }, "a review stored before depth checks gates as before");
  const legacy = reviewGate({ review_verdict: "conditional_pass", findings: [{ severity: "critical" }, { severity: "critical" }] });
  assert.deepEqual([legacy.trackable, legacy.positionable, legacy.blocking], [true, false, ["Unresolved critical finding"]],
    "a stored review with an open critical finding blocks a position even without effective_verdict");
  assert.equal(reviewGate(null).trackable, false);
});
const missingCritical = () => ({ ...deriveReview(review({ depth_checks: withStatus("thesis_breakers", "missing") }), []), findings: [] });

test("the last conclusion's coverage replaces the planner's, and code downgrades what the facts contradict", () => {
  const planned = [{ key: "downside", status: "satisfied" as const, rationale: "Bear and no-rerating downside are quantified.", section_ids: ["valuation"] },
    { key: "monitoring", status: "satisfied" as const, rationale: "Thresholds set.", section_ids: ["monitoring"] }];
  const sections = [{ id: "valuation", gaps: [] }, { id: "monitoring", gaps: [] }] as any;
  const reconciled = reconcileCoverage(planned, [{ key: "monitoring", status: "satisfied", rationale: "Five monitored numbers.", section_ids: ["other"] }],
    { artifacts: [facts(null)] as any, sections, findings: [{ section_id: "monitoring", issue: "The margin thresholds cannot be tested from the dashboard." }] });
  assert.equal(reconciled[0].status, "qualified");
  assert.match(reconciled[0].rationale, /not computed/);
  assert.equal(reconciled[1].status, "qualified", "a finding that thresholds can't be tested");
  assert.deepEqual(reconciled[1].section_ids, ["monitoring"], "section links stay the planner's");
  const stated = reconcileCoverage(planned, undefined, { artifacts: [facts(null)] as any, sections: [{ id: "valuation", gaps: ["No-rerating return is not available."] }] as any });
  assert.equal(stated[0].status, "satisfied", "a stated gap is enough");
});

const plan = (id: string, coverage: string[]) => ({ id, title: id, purpose: "Explain", coverage, artifact_ids: [] });
const sectionFor = (p: any, text = "Revenue grew 12% in FY2024.") => ({ ...p, paragraphs: [{ kind: "analysis", text, evidence_ids: [], artifact_ids: [] }],
  counterevidence: "Competition.", implication: "Margins hold.", gaps: [], tables: [] });

test("compose uses the conclusion's coverage, repairs open high findings under conditional_pass, and reworks once after saving the review", async () => {
  const plans = [plan("summary", ["conclusion"]), plan("valuation", ["valuation", "downside"])];
  const outline = { sections: plans, questions: [], coverage: [
    { key: "conclusion", status: "qualified", rationale: "Planned", section_ids: ["summary"] },
    { key: "valuation", status: "qualified", rationale: "Planned", section_ids: ["valuation"] },
    { key: "downside", status: "satisfied", rationale: "Planned", section_ids: ["valuation"] }] };
  const events: string[] = [];
  let reviews = 0;
  const result = await composeReviewedReport({ asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["conclusion", "valuation", "downside"] }, {
    plan: async () => outline as any,
    write: async (p, _o, feedback, _c, options) => {
      events.push(`write:${p.id}${feedback.length ? ":repair" : ""}`);
      if (feedback.length && p.id === "valuation") assert.ok(feedback.some(f => f.category === "team_answer"), "owners' answers reach the named section");
      return { ...sectionFor(p), ...(options?.coverage ? { final_coverage: options.coverage.map(c => c.key === "downside" ? { ...c, status: "qualified", rationale: "Only the bear case is valued." } : c) } : {}) } as any;
    },
    review: async document => {
      events.push("review");
      if (++reviews === 1) assert.equal(document.coverage.find(c => c.key === "downside")!.status, "qualified", "the writer's coverage is used");
      return { review_summary: "x", quality_score: 0.5, recommendations: [], review_verdict: "conditional_pass", depth_checks: allMet(),
        findings: reviews === 1 ? [{ section_id: "valuation", category: "calculation", severity: "high", issue: "The bear case omits dilution." }] : [] };
    },
    rework: async r => { events.push(`rework:${r.findings.length}`); return [{ category: "team_answer", section_id: "valuation", answer: "Dilution is 2% a year." }]; },
    save: async type => { if (type === "report_review") events.push("save:review"); },
  });
  assert.deepEqual(events, ["write:valuation", "write:summary", "review", "save:review", "rework:1", "write:valuation:repair", "write:summary:repair", "review", "save:review"]);
  assert.equal(result.review.model_verdict, "conditional_pass");
});

test("post-review requests get their own round, rework requests name their stage, and writers see only pre-draft requests", () => {
  const ask = (question: string) => ({ role: "business" as const, question, material: true, needs_sources: false, source_role: "regulatory_filing" as const });
  const first = nextRequestBatch(null, [ask("Which segment loses money?")])!;
  const second = nextRequestBatch({ ...first, state: "answered" }, [ask("What is the net cash position?")])!;
  assert.equal(nextRequestBatch({ ...second, state: "answered" }, [ask("A third pre-draft question?")]), null, "two pre-draft rounds");
  const rework = reworkRequests([{ category: "analysis_rework", owner_stage: "asset_valuation", section_id: "valuation", issue: "Terminal multiple on peak capex" },
    { category: "analysis_rework", owner_stage: "asset_valuation", issue: "Duplicate" }, { category: "writing", owner_stage: "moat_analysis" }]);
  assert.equal(rework.length, 1);
  assert.equal(rework[0].role, "valuation");
  const review = nextRequestBatch({ ...second, state: "answered" }, [...rework, ask("Peer pricing for Snap?")], "post_review")!;
  assert.equal(review.post_review_round, 3);
  assert.equal(nextRequestBatch({ ...review, state: "answered" }, [ask("Anything else at all?")], "post_review"), null, "one post-review round");
  assert.equal(nextRequestBatch({ ...review, state: "answered" }, [ask("Anything else at all?")]), null, "no pre-draft round after the review");
  assert.deepEqual(preDraftRequests(review).map(r => r.id), ["request-1-1", "request-2-1"]);

  const reworkRequest = review.requests.find(r => r.rework_stage) as TeamRequest;
  const asked = { ...reworkRequest, response: reworkAnswer(reworkRequest) };
  assert.equal(asked.response.requires_rerun, true);
  assert.deepEqual(requestStageRoots([asked]), ["asset_valuation"]);
  const after = reworkAnswer({ ...reworkRequest, reworked: true });
  assert.equal(after.requires_rerun, undefined, "a granted rework is answered, not rerun again");
  const answered: RequestBatch = { ...review, state: "answered", requests: review.requests.map(r => r.id === asked.id ? asked : r) };
  assert.deepEqual(postReviewAnswers(answered).map(a => a.section_id), ["valuation"]);
});

test("substance checks reach gaps, captions, table titles, questions and coverage with narrow narration patterns", () => {
  const base = { id: "valuation", title: "Valuation", purpose: "x", coverage: ["valuation"], artifact_ids: [], counterevidence: "Rates may fall.", implication: "Value holds.",
    paragraphs: [{ kind: "fact", text: "Revenue grew 12%.", evidence_ids: ["e1"], artifact_ids: [] }], gaps: [], tables: [] } as any;
  const hits = (extra: Record<string, unknown>) => checkReportSubstance([{ ...base, ...extra }]).map(f => f.issue);
  assert.match(hits({ gaps: ["Citations removed because their source is undated."] })[0], /gap 1/);
  assert.match(hits({ tables: [{ title: "Stored FCFF cases", artifact_id: "a", path: "" }] })[0], /table 1 title/);
  assert.match(hits({ visuals: [{ kind: "series", title: "Margins", caption: "Code rebuilds the base case from stored FCFF." }] })[0], /visual 1 caption/);
  for (const text of ["An earlier draft quoted 513.71.", "The model's note says escrow is excluded.", "It is not in the stored matrix (the field is null).", "The reconciliation record shows 190.56."])
    assert.equal(hits({ paragraphs: [{ kind: "fact", text, evidence_ids: ["e1"], artifact_ids: [] }] }).length, 1, text);
  for (const text of ["The model's base case assumes 9% growth.", "The prior version of the 10-K restated leases.", "The historical record shows 20 quarters."])
    assert.equal(hits({ paragraphs: [{ kind: "fact", text, evidence_ids: ["e1"], artifact_ids: [] }] }).length, 0, text);
  const outline = checkReportSubstance([base], { questions: [{ id: "q1", question: "Is churn known?", answer: "The supplied passages are cover pages.", materiality: "material", status: "blocked", evidence_ids: [], artifact_ids: [], follow_up: "x" }],
    coverage: [{ key: "moat", status: "qualified", rationale: "Not in the corpus.", section_ids: ["moat"] }] });
  assert.deepEqual(outline.map(f => f.section_id), ["", "moat"], "question findings carry no section, so they never force a section rewrite");
});

test("human rubric ratings accept 0-4 integers for known dimensions only", () => {
  assert.deepEqual(parseRubricRatings({ framing: "3", valuation: 1, moat: "" }), { framing: 3, valuation: 1 });
  assert.equal(parseRubricRatings({}), null);
  assert.throws(() => parseRubricRatings({ framing: 5 }), /0 to 4/);
  assert.throws(() => parseRubricRatings({ vibes: 2 }), /Unknown rubric dimension/);
  assert.equal(ratingAgreement({ framing: 3, valuation: 1 }, { framing: 2, valuation: 3 }), 0.5);
});
