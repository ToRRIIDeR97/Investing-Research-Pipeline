import test from "node:test";
import assert from "node:assert/strict";
import { fitPacket, REPORT_PACKET_BYTES } from "../src/lib/research/reporting/packet";
import { sectionEvidence, valuationRework, reportSectionCall } from "../src/lib/research/reporting/runtime";
import { COVERAGE, REPORT_CHAPTERS, MAX_SECTION_PARAGRAPHS, STANDARD_VERSION, ADAPTIVE_3_STANDARD, fitOutlineToChapters, storedSection,
  validateProductOutline, type ReportOutline } from "../src/lib/research/reporting/contracts";
import { valuationCheck } from "../src/lib/research/reporting/facts";
import { createReport } from "../src/lib/research/reporting/report";
import { hasCodeExhibits } from "../src/lib/research/reporting/exhibits";
import { reworkRequests, withoutReworkedOwners, limitReruns, rerunRoots, requestResetPlan, type TeamRequest } from "../src/lib/research/team";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("fitPacket returns a packet that fits unchanged, and shrinks a large one under the budget", () => {
  const small = { artifacts: [{ id: "a", content_json: { x: 1 } }], evidence_claims: [{ id: "e", quote: "q" }] };
  assert.equal(fitPacket(small), small);
  const big = { artifacts: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, artifact_type: `t${i}`, content_json: { schedule: "z".repeat(9000), status: "ok" } })),
    evidence_claims: Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, claim_text: "c".repeat(200), quote: "q".repeat(600) })) };
  assert.ok(size(big) > REPORT_PACKET_BYTES);
  const fitted = fitPacket(big);
  assert.ok(size(fitted) <= REPORT_PACKET_BYTES, `fitted to ${size(fitted)} bytes`);
  // The 9 KB field goes first (8 KB cap); the rest of each artifact stays.
  assert.deepEqual((fitted.artifacts[0] as any).omitted_fields, ["schedule"]);
  assert.equal((fitted.artifacts[0] as any).content_json.status, "ok");
});

test("fitPacket drops claim quotes, then claims, then the largest artifacts, and names those it drops", () => {
  const packet = { artifacts: [{ id: "a", artifact_type: "huge", content_json: "x".repeat(150_000) }, { id: "b", artifact_type: "small", content_json: "y" }],
    evidence_claims: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, quote: "q".repeat(100) })) };
  const fitted = fitPacket(packet) as any;
  assert.ok(size(fitted) <= REPORT_PACKET_BYTES);
  assert.ok(fitted.evidence_claims.every((claim: any) => !("quote" in claim)));
  assert.deepEqual(fitted.artifacts.map((a: any) => a.id), ["b"]);
  assert.deepEqual(fitted.omitted_artifacts, ["huge"]);
  // A different claim key (the team-request packet's `evidence`).
  const team = fitPacket({ evidence: Array.from({ length: 400 }, (_, i) => ({ id: `e${i}`, quote: "q".repeat(400) })) }, undefined, "evidence") as any;
  assert.ok(team.evidence.every((claim: any) => !("quote" in claim)));
});

test("sectionEvidence keeps claims the chapter's artifacts cite, then the best word matches, in evidence order", () => {
  const evidence = Array.from({ length: 60 }, (_, i) => ({ id: `ev-${i}`, claim_text: i === 59 ? "Net charge-offs on card loans rose" : `Unrelated filing note ${i}` }));
  const section = { id: "business", title: "Card lending", purpose: "Why charge-offs moved", coverage: ["business"], artifact_ids: [] };
  const picked = sectionEvidence(evidence, section, [{ content_json: { supporting_claim_ids: ["ev-3"] } }], 5);
  assert.equal(picked.length, 5);
  assert.ok(picked.some(e => e.id === "ev-3"), "the claim an artifact cites");
  assert.ok(picked.some(e => e.id === "ev-59"));
  assert.deepEqual(picked.map(e => e.id), [...picked].sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3))).map(e => e.id));
  // Fewer claims than the cap: all of them.
  assert.equal(sectionEvidence(evidence.slice(0, 3), section, []).length, 3);
});

test("a body chapter's packet carries only its claims and stays under the budget", () => {
  const evidence = Array.from({ length: 300 }, (_, i) => ({ id: `ev-${i}`, claim_text: `claim ${i}`, quote: "q".repeat(500) }));
  const outline = fitOutlineToChapters({ sections: [], coverage: [], questions: [] }, []);
  const artifacts = [{ id: "a", artifact_type: "segment_model", content_json: { rows: "r".repeat(200_000) } }];
  const call = reportSectionCall({ evidence_claims: evidence }, artifacts, outline.sections[1], outline, [], []);
  assert.ok(call.packet.evidence_claims.length <= 40);
  assert.ok(size(call.packet) <= REPORT_PACKET_BYTES);
  assert.ok(call.perCallKeys.includes("evidence_claims") && call.perCallKeys.includes("filing_passages"));
});

test("fitOutlineToChapters fixes the six chapters, keeps the model's wording and statuses, and passes the outline rules", () => {
  const model: ReportOutline = {
    sections: [{ id: "valuation", title: "What SoFi is worth", purpose: "Value against price", coverage: ["valuation"], artifact_ids: ["v", "unknown"], key_figures: ["FY2026 ROE"] },
      { id: "extra", title: "Extra", purpose: "p", coverage: ["history"], artifact_ids: [] }],
    coverage: [{ key: "moat", status: "blocked", rationale: "No customer data.", section_ids: ["extra"] }],
    questions: Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, question: "q", materiality: "material" as const, status: "answered" as const, answer: "a", evidence_ids: [], artifact_ids: [], follow_up: "" })),
  };
  const artifacts = [{ id: "v", artifact_type: "valuation_scenario_set" }, { id: "m", artifact_type: "moat_assessment" }];
  const fixed = fitOutlineToChapters(model, artifacts);
  assert.deepEqual(fixed.sections.map(s => s.id), REPORT_CHAPTERS.map(c => c.id));
  const valuation = fixed.sections.find(s => s.id === "valuation")!;
  assert.equal(valuation.title, "What SoFi is worth");
  assert.deepEqual(valuation.coverage, ["forecasts", "valuation", "downside"]);
  assert.deepEqual(valuation.artifact_ids, ["v"]);
  assert.deepEqual(fixed.sections.find(s => s.id === "competition")!.artifact_ids, ["m"]);
  const moat = fixed.coverage.find(c => c.key === "moat")!;
  assert.deepEqual(moat, { key: "moat", status: "blocked", rationale: "No customer data.", section_ids: ["competition"] });
  assert.deepEqual(fixed.coverage.map(c => c.key), Object.keys(COVERAGE));
  assert.equal(fixed.questions.length, 8);
  assert.doesNotThrow(() => validateProductOutline(fixed));
});

test("storedSection keeps at most MAX_SECTION_PARAGRAPHS paragraphs", () => {
  const paragraphs = Array.from({ length: 9 }, (_, i) => ({ kind: "analysis" as const, text: `p${i}`, evidence_ids: [], artifact_ids: [] }));
  const stored = storedSection({ id: "business", title: "t", purpose: "p", coverage: ["business"], artifact_ids: [], paragraphs, counterevidence: "c", implication: "i", gaps: [] }, []);
  assert.equal(stored.paragraphs.length, MAX_SECTION_PARAGRAPHS);
});

test("valuationCheck flags SoFi 0c9a2731's valuation and passes a plausible one", () => {
  const sofi = [{ case: "bear", explicit_cash_flow_sum: -5215.8, tv_share_of_ev: null }, { case: "base", explicit_cash_flow_sum: -6966.2, tv_share_of_ev: 4.4706 },
    { case: "bull", explicit_cash_flow_sum: -7686.4, tv_share_of_ev: 1.6436 }];
  const flagged = valuationCheck(sofi, 1.38, 14.28);
  assert.equal(flagged.status, "flagged");
  assert.equal(flagged.reasons.length, 3);
  assert.match(flagged.reasons[0], /1\.38 per share is 10% of the 14\.28 market price/);
  const fine = [{ case: "bear", explicit_cash_flow_sum: 900, tv_share_of_ev: 0.6 }, { case: "base", explicit_cash_flow_sum: 1200, tv_share_of_ev: 0.7 },
    { case: "bull", explicit_cash_flow_sum: 1500, tv_share_of_ev: 0.75 }];
  assert.deepEqual(valuationCheck(fine, 18, 14.28), { status: "pass", reasons: [] });
  // A bank earning below its cost of equity has negative excess returns in every case; on the excess-return method that
  // is a finding, not a model error, so it alone does not flag the valuation.
  const bank = ["bear", "base", "bull"].map(c => ({ case: c, method: "residual_income", explicit_cash_flow_sum: -120, tv_share_of_ev: 0.1 }));
  assert.deepEqual(valuationCheck(bank, 6.5, 12.86), { status: "pass", reasons: [] });
});

test("a flagged valuation is sent back to asset_valuation once per run", () => {
  const facts = { valuation_check: { status: "flagged", reasons: ["Too low."] } };
  const [finding] = valuationRework(facts, null);
  assert.equal(finding.category, "analysis_rework");
  assert.equal(finding.owner_stage, "asset_valuation");
  assert.match(finding.issue, /Too low\./);
  assert.deepEqual(valuationRework(facts, { requests: [{ rework_stage: "asset_valuation" }] }), []);
  assert.deepEqual(valuationRework({ valuation_check: { status: "pass", reasons: [] } }, null), []);
  assert.deepEqual(valuationRework(null, null), []);
});

test("adaptive-4 reports state a provisional view; adaptive-3 reports keep their banner and code exhibits", () => {
  const input = { asset_name: "Co", cutoff: "2026-11-18T00:00:00.000Z", is_test: false, required_coverage: ["conclusion"], evidence: [], artifacts: [], questions: [],
    sections: [{ id: "verdict", title: "Verdict", purpose: "p", coverage: ["conclusion"], artifact_ids: [], tables: [],
      paragraphs: [{ kind: "analysis" as const, text: "Not yet investable, low confidence.", evidence_ids: [], artifact_ids: [] }], counterevidence: "c", implication: "i", gaps: [] }],
    coverage: [{ key: "conclusion", status: "blocked" as const, rationale: "Funding cost untested.", section_ids: ["verdict"] }] };
  const current = createReport(input);
  assert.equal(current.standard_version, STANDARD_VERSION);
  assert.equal(current.conclusion_status, "withheld", "the status still blocks position approval");
  assert.match(current.markdown, /Provisional view - material questions remain open/);
  const stored = createReport({ ...input, standard_version: ADAPTIVE_3_STANDARD } as any);
  assert.equal(stored.standard_version, ADAPTIVE_3_STANDARD);
  assert.match(stored.markdown, /Conclusion withheld - research incomplete/);
  assert.ok(hasCodeExhibits(ADAPTIVE_3_STANDARD) && hasCodeExhibits(STANDARD_VERSION) && !hasCodeExhibits("asset-framework-2.1-adaptive-2"));
});

test("while code sends the valuation back, the round asks its owner nothing else (SoFi 7c70364e's duplicate)", () => {
  const rework = reworkRequests(valuationRework({ valuation_check: { status: "flagged", reasons: ["The terminal value is 97% of the base case's value."] } }, null));
  assert.equal(rework.length, 1);
  const asked = [
    { role: "valuation", question: "The valuation check flagged that the terminal value is 97% of the base case value. Recheck the scenario cash flows." },
    { role: "financials", question: "Extract Q3 2026 income from operations from the 10-Q." },
    { role: "data", question: "Obtain SoFi Bank's FFIEC Call Report." }];
  assert.deepEqual(withoutReworkedOwners(asked, rework).map(r => r.role), ["financials", "data"]);
  assert.deepEqual(withoutReworkedOwners(asked, []), asked);
});

test("a stage reruns once per run for requests, and an unavailable answer never asks for one (SoFi 7c70364e's loop)", () => {
  const base = { material: true, needs_sources: false, source_role: "regulatory_filing" as const };
  const ref = { evidence_ids: [], artifact_ids: ["a1"] };
  const requests = [
    { ...base, id: "request-1-3", role: "valuation", question: "Recheck the valuation.", response: { ...ref, status: "answered", answer: "The 2026 tax rate is wrong.", requires_rerun: true } },
    { ...base, id: "request-2-1", role: "valuation", question: "Reconcile the values.", response: { ...ref, status: "unavailable", answer: "Cannot be completed.", requires_rerun: true } },
    { ...base, id: "request-2-2", role: "financials", question: "Restate Q3.", response: { ...ref, status: "answered", answer: "Margins are misstated.", requires_rerun: true } },
    { ...base, id: "request-2-3", role: "data", question: "Verify the close.", response: { ...ref, status: "answered", answer: "12.15 on 25 November." } },
  ] as TeamRequest[];
  const stages = ["historical_record", "asset_valuation", "decision_synthesis", "report_draft", "ai_reviewer"].map(stage_key => ({ stage_key, status: "completed" }));

  // First pass: nothing has rerun yet, so the answered valuation request still asks for its rerun.
  const first = limitReruns(requests, new Set());
  assert.equal(first[0], requests[0]);
  assert.equal(first[1].response?.requires_rerun, undefined);
  assert.equal(first[1].response?.status, "unavailable");
  assert.equal(first[3], requests[3]);

  // An applied reset's roots are the stages its requests asked for, not the dependents it also reopened.
  assert.deepEqual([...rerunRoots(requests, ["request-1-3"])], ["asset_valuation"]);
  // After asset_valuation was rerun, its owner cannot reopen it again: the answer becomes an open question.
  const after = limitReruns(requests, rerunRoots(requests, ["request-1-3"]));
  assert.equal(after[0].response?.status, "unavailable");
  assert.equal(after[0].response?.requires_rerun, undefined);
  assert.match(after[0].response!.answer, /^Not rerun: asset_valuation was already rerun in this run\. The owner's answer was: The 2026 tax rate is wrong\./);
  // Another stage's first rerun is still allowed.
  assert.equal(after[2], requests[2]);
  const plan = requestResetPlan(after, stages, { autoResetUsed: true });
  assert.deepEqual(plan.request_ids, ["request-2-2"]);
  assert.equal(requestResetPlan(after.slice(0, 2), stages, { autoResetUsed: true }).mode, "none");
});
