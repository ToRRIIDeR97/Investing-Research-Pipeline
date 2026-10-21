import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { figureTrace, traitPresence, runChecks } from "../src/lib/research/scoring/checks";
import { probeReport, probeStatus, reportSentences, type ProbeSpec } from "../src/lib/research/scoring/depth-probes";
import { coefficientOfVariation, stabilityReport } from "../src/lib/research/scoring/stability";
import { judgeContract, judgePacket } from "../src/lib/research/scoring/judge";
import { RUBRIC_DIMENSIONS } from "../src/lib/research/scoring/rubric";
import { DEPTH_CHECKS } from "../src/lib/research/reporting/depth";

const document = {
  asset_name: "Fixture", cutoff: "2026-01-01",
  evidence: [{ id: "e1", claim_text: "Revenue was $51,236 million in Q2 2026.", quote: "Revenue $51,236" }],
  artifacts: [{ id: "a1", artifact_type: "report_facts", content_json: { fcf_yield: 0.0215, ev: 1036059.4 } }],
  sections: [{ id: "business", title: "Business", coverage: ["business"], gaps: ["Class B voting power is not disclosed in the filings reviewed."], tables: [],
    paragraphs: [
      { kind: "fact", text: "Revenue reached $51.24 billion, and FCF yield is 2.15%.", evidence_ids: ["e1"], artifact_ids: ["a1"] },
      { kind: "fact", text: "Enterprise value is 1,036,059 and explicit PV is -94,163.", evidence_ids: [], artifact_ids: ["a1"] },
      { kind: "analysis", text: "Against the 20-quarter median the margin sits near the top; scorecard below.", evidence_ids: [], artifact_ids: [] }],
    counterevidence: "What would change my mind: a margin under 30%.", implication: "No-rerating return of 12.5% over three years." }],
  questions: [], coverage: [],
};

test("figures trace to their paragraph's cited inputs at displayed precision and unit scale", () => {
  const trace = figureTrace(document)!;
  assert.equal(trace.figures, 4, "51.24, 2.15, 1,036,059 and -94,163; the year 2026 is skipped");
  assert.equal(trace.matched, 3, "51.24 (millions to billions), 2.15 (ratio to percent), 1,036,059 (rounded)");
  assert.deepEqual(trace.unmatched_examples, [{ section_id: "business", figure: "-94,163" }]);
});

test("JD traits are read from prose only", () => {
  const present = traitPresence(document).filter(t => t.present).map(t => t.id);
  assert.deepEqual(present, ["history_statistics", "fcf_yield", "no_rerating_return", "what_would_change_my_mind", "scorecard"]);
});

test("a probe flags a stored fact the report calls unavailable or never mentions", () => {
  const sentences = reportSentences(document);
  const voting: ProbeSpec = { id: "voting", label: "Voting control", data: { source: "chunks", text: "voting", min: 2 }, report: { topic: "voting power" } };
  assert.equal(probeStatus(10, voting, probeReport(voting, sentences)).status, "reported_unavailable");
  assert.equal(probeStatus(1, voting, probeReport(voting, sentences)).status, "not_in_data", "below the data minimum");
  const leases: ProbeSpec = { id: "leases", label: "Leases", data: { source: "chunks", text: "278" }, report: { topic: "not yet commenced", value: "278\\.99" } };
  assert.equal(probeStatus(3, leases, probeReport(leases, sentences)).flagged, true);
  const revenue: ProbeSpec = { id: "rev", label: "Revenue", data: { source: "claims", text: "revenue" }, report: { topic: "revenue", value: "51\\.24" } };
  assert.equal(probeStatus(3, revenue, probeReport(revenue, sentences)).status, "reported");
});

test("the eval set names the five cases, and JD is a coverage stress case", () => {
  const set = JSON.parse(readFileSync(new URL("../evals/eval-set.json", import.meta.url), "utf8"));
  assert.deepEqual(set.cases.map((c: any) => c.id), ["META", "SOFI", "DECK", "MELI", "JD"]);
  assert.equal(set.cases.find((c: any) => c.id === "JD").role, "coverage_stress");
  for (const probe of set.cases.flatMap((c: any) => c.probes)) { new RegExp(probe.report.topic, "i"); if (probe.report.value) new RegExp(probe.report.value, "i"); }
  assert.equal(set.cases.find((c: any) => c.id === "META").probes.length, 8);
});

test("stability reports per-case variation and the model's terminal choices", () => {
  assert.equal(coefficientOfVariation([1]), null);
  assert.equal(coefficientOfVariation([100, 100]), 0);
  const snapshot = (id: string, base: number) => ({ run: { id, created_at: "2026-10-01T00:00:00Z", cutoff: "2026-10-01T00:00:00Z" }, artifacts: [
    { id: "f", artifact_type: "report_facts", artifact_version: 1, content_json: { cases: { columns: ["case", "pv_per_share"], rows: [["bear", base / 2], ["base", base], ["bull", base * 2]] } } },
    { id: "v", artifact_type: "valuation_scenario_set", artifact_version: 1, content_json: { method_inputs: [{ scenario_type: "base", method: "fcff", discount_rate: 0.09, terminal: { type: "multiple", multiple: 14, metric: "nopat" } }] } }] }) as any;
  const report = stabilityReport([snapshot("r1", 400), snapshot("r2", 500)]);
  assert.equal(report.runs, 2);
  assert.equal(report.pv_per_share_cv.base, 0.1571);
  assert.equal((report.choices[0] as Record<string, string>).base, "14x nopat @ 0.09");
});

test("the judge reads only its dimension's chapters and must quote them verbatim", () => {
  const valuation = RUBRIC_DIMENSIONS.find(d => d.id === "business_economics")!;
  const packet = judgePacket(valuation, document, document.artifacts);
  assert.deepEqual(packet.sections.map((s: any) => s.id), ["business"]);
  const contract = judgeContract(packet);
  assert.deepEqual(contract.validate!({ score: 2, rationale: "Partial", missing: [], quotes: [{ section_id: "business", quote: "Revenue reached $51.24 billion" }] }), []);
  assert.match(contract.validate!({ score: 3, rationale: "Good", missing: [], quotes: [{ section_id: "business", quote: "Segment margins were computed" }] })[0].message, /not found/);
  assert.match(contract.validate!({ score: 3, rationale: "Good", missing: [], quotes: [] })[0].message, /at least one/);
  for (const d of RUBRIC_DIMENSIONS) for (const id of d.depth_checks) assert.ok(DEPTH_CHECKS.some(c => c.id === id), `${d.id} names ${id}`);
});

test("code checks run on a snapshot without a report", () => {
  const checks = runChecks({ run: { id: "r", cutoff: "2026-01-01T00:00:00Z" } as any, artifacts: [
    { id: "h", artifact_type: "historical_record", scope_key: "h", artifact_version: 1, content_json: { ttm_series: [], statistics: {} } }],
    review: null, document: null, hygiene: { accepted_claims: 3, claims_after_cutoff: 0, undated_claims: 1 } });
  assert.equal(checks.find(c => c.id === "ttm_statistics")!.status, "fail");
  assert.equal(checks.find(c => c.id === "report_document")!.status, "fail");
  assert.equal(checks.find(c => c.id === "hygiene_after_cutoff")!.status, "pass");
});
