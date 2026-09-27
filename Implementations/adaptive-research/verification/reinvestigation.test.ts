import test from "node:test";
import assert from "node:assert/strict";
import { composeReviewedReport } from "../../../src/lib/research/reporting/compose";

test("AC-4: a research gap gets one corpus re-investigation and remains explicit", async () => {
  let plans = 0, reviews = 0;
  const plan = { id: "funding", title: "Funding limits", purpose: "Test commitments", coverage: ["downside"], artifact_ids: [] };
  const result = await composeReviewedReport({ asset_name: "No disclosure", cutoff: "2025-01-01", is_test: true,
    required_coverage: ["downside"], artifacts: [], evidence: [] }, {
    plan: async feedback => { plans++; if (plans === 2) assert.equal(feedback[0].category, "research_gap"); return {
      sections: [plan], coverage: [{ key: "downside", status: "blocked", rationale: "Debt maturities are unavailable.", section_ids: ["funding"] }],
      questions: [{ id: "maturities", question: "When does debt mature?", materiality: "critical", status: "blocked", answer: "The corpus does not disclose maturities.", evidence_ids: [], artifact_ids: [], follow_up: "Obtain the maturity schedule." }],
    }; },
    write: async () => ({ ...plan, paragraphs: [{ kind: "analysis", text: "Funding cannot be assessed from the corpus.", evidence_ids: [], artifact_ids: [] }],
      counterevidence: "No maturity schedule is available.", implication: "Withhold a conclusion.", gaps: ["Debt maturity schedule"], tables: [] }),
    review: async () => { reviews++; return { review_summary: "The funding gap remains unresolved.", quality_score: 0.2, recommendations: [], review_verdict: "needs_more_work", findings: [{ section_id: "funding", category: "research_gap", message: "Missing maturity schedule" }] }; },
    save: async () => {},
  });
  assert.equal(plans, 2); assert.equal(reviews, 2);
  assert.equal(result.document.conclusion_status, "withheld");
  assert.equal(result.review.review_verdict, "needs_more_work");
});
