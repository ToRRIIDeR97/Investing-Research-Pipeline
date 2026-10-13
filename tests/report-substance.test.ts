import test from "node:test";
import assert from "node:assert/strict";
import { checkReportSubstance } from "../src/lib/research/reporting/substance";
import { composeReviewedReport } from "../src/lib/research/reporting/compose";

const section = (paragraphs: { kind: string; text: string; evidence_ids?: string[]; artifact_ids?: string[] }[], extra: Record<string, string> = {}) => ({
  id: "moat", title: "Switching costs in payments", purpose: "Explain", coverage: ["moat"], artifact_ids: [],
  paragraphs: paragraphs.map(p => ({ evidence_ids: [], artifact_ids: [], ...p })),
  counterevidence: "Competitors cut prices in 2024.", implication: "Margins hold if retention stays above 90%.", gaps: [], tables: [], ...extra,
}) as any;

test("an analysis paragraph needs a figure or a citation", () => {
  const findings = checkReportSubstance([section([
    { kind: "analysis", text: "Customers value the product and the brand is strong." },
    { kind: "analysis", text: "Take rate rose to 2.9% in FY2024 as mix shifted to cross-border volume." },
    { kind: "analysis", text: "Pricing power explains the margin gain.", evidence_ids: ["e1"] },
    { kind: "assumption", text: "Management will keep discipline." },
  ])]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /paragraph 1 has no figure and no citation/);
  assert.equal(findings[0].section_id, "moat");
  assert.equal(findings[0].category, "writing");
});

test("display text that leaks pipeline terms is flagged; ordinary prose is not", () => {
  const leaks = [
    "Churn is not in the corpus.",
    "The link has node confidence 0.35.",
    "The artifact does not disclose take rate.",
    "The supplied passages omit 2023 pricing.",
    "Retention (confidence: 0.6) looks stable.",
    "See 3f2b1c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f for detail.",
    "The metric_key revenue_growth fell 3%.",
  ];
  for (const text of leaks) assert.equal(checkReportSubstance([section([{ kind: "fact", text, evidence_ids: ["e1"] }])]).length, 1, text);
  assert.equal(checkReportSubstance([section([{ kind: "fact", text: "TSMC's 3nm process node lifted gross margin to 53% with high confidence from customers.", evidence_ids: ["e1"] }])]).length, 0);
  assert.equal(checkReportSubstance([section([{ kind: "fact", text: "Revenue grew 12%.", evidence_ids: ["e1"] }], { implication: "No corpus evidence supports a higher multiple." })])[0].issue,
    "The implication uses internal pipeline terms (corpus).");
});

test("substance findings send a passed review through the writing repair", async () => {
  const plan = { id: "moat", title: "Moat", purpose: "Explain", coverage: ["moat"], artifact_ids: [] };
  const feedbacks: Record<string, any>[][] = [];
  const result = await composeReviewedReport({ asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["moat"] }, {
    plan: async () => ({ sections: [plan], questions: [], coverage: [{ key: "moat", status: "qualified", rationale: "Fixture", section_ids: ["moat"] }] }),
    write: async (p, _outline, feedback) => {
      feedbacks.push(feedback);
      return section([{ kind: "analysis", text: feedback.length ? "Retention held at 95% in FY2024." : "The moat is strong." }], { id: p.id, title: p.title }) as any;
    },
    review: async () => ({ review_summary: "ok", findings: [], quality_score: 0.9, recommendations: [], review_verdict: "pass" }),
    save: async () => {},
  });
  assert.equal(feedbacks.length, 2, "one repair");
  assert.equal(feedbacks[1][0].source, "substance_check");
  assert.equal(result.document.sections[0].paragraphs[0].text, "Retention held at 95% in FY2024.");
  assert.deepEqual(result.review.findings, [], "the repaired report passes the check");
});
