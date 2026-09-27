import test from "node:test";
import assert from "node:assert/strict";
import { composeReviewedReport } from "../../../src/lib/research/reporting/compose";

test("AC-4: complete report review repairs affected writing once and stops on repeated failure", async () => {
  let writes = 0, reviews = 0;
  const saved: string[] = [];
  const plan = { id: "s", title: "Funding", purpose: "Explain uncertainty", coverage: ["downside"], artifact_ids: [] };
  const result = await composeReviewedReport({ asset_name: "Fixture", cutoff: "2026-01-01", is_test: true,
    artifacts: [], evidence: [], required_coverage: ["downside"] }, {
    plan: async () => ({ sections: [plan], questions: [], coverage: [{ key: "downside", status: "blocked", rationale: "No funding disclosure", section_ids: ["s"] }] }),
    write: async () => { writes++; return { ...plan, paragraphs: [{ kind: "assumption", text: `Unresolved financing, draft ${writes}.`, evidence_ids: [], artifact_ids: [] }], counterevidence: "Unavailable", implication: "Withhold conclusion", gaps: ["Funding"], tables: [] }; },
    review: async (doc) => { reviews++; assert.match(doc.markdown, /Funding/); return { review_summary: "More explanation needed", findings: [{ section_id: "s", category: "writing" }], quality_score: 0.2, recommendations: [], review_verdict: "needs_more_work" }; },
    save: async (type) => { saved.push(type); },
  });
  assert.equal(writes, 2); assert.equal(reviews, 2);
  assert.equal(result.document.conclusion_status, "withheld");
  assert.ok(saved.includes("question_register"));
});

test("AC-8: persistence failures stop report generation", async () => {
  await assert.rejects(composeReviewedReport({ asset_name: "X", cutoff: "2026-01-01", is_test: true,
    artifacts: [], evidence: [], required_coverage: ["history"] }, {
    plan: async () => ({ sections: [{ id: "h", title: "History", purpose: "History", coverage: ["history"], artifact_ids: [] }], questions: [], coverage: [{ key: "history", status: "blocked", rationale: "Missing", section_ids: ["h"] }] }),
    write: async () => { throw new Error("Must not write after persistence failed"); },
    review: async () => { throw new Error("Must not review"); }, save: async () => { throw new Error("Database unavailable"); },
  }), /Database unavailable/);
});
