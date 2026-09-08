import { describe, it } from "node:test";
import assert from "node:assert";
import { validateAiReviewSelfConsistency } from "@/lib/research/handlers/ai-reviewer";

describe("AI reviewer validation", () => {
  it('rejects findings that cannot be routed to a supplied artifact', () => {
    for (const artifact_refs of [[], ['invented']]) {
      const errors = validateAiReviewSelfConsistency({ pass_fail: 'fail', findings: [{ message: 'Unsupported conclusion', artifact_refs }] }, undefined, ['risk_register']);
      assert.ok(errors.some((error) => error.path === 'findings'));
    }
    assert.equal(validateAiReviewSelfConsistency({ pass_fail: 'fail', findings: [{ message: 'Unsupported conclusion', artifact_refs: ['risk_register'] }] }, undefined, ['risk_register']).length, 0);
  });
  it("rejects a false claim that reconciled backtest status counts do not sum", () => {
    const errors = validateAiReviewSelfConsistency({
      pass_fail: "pass",
      review_summary: "Status counts are not summing to the executed population.",
      findings: [],
    }, {
      framework_gate: { combinations_tested: 50 },
      status_counts: { Robust: 10, Promising: 20, Weak: 15, Rejected: 5 },
    });

    assert.ok(errors.some((error) => error.path === "review_summary"));
  });

  it("rejects a vague inconsistency claim when the counts reconcile", () => {
    const errors = validateAiReviewSelfConsistency({
      pass_fail: "pass",
      review_summary: "Minor inconsistencies in status counts and metric values were noted.",
      findings: [],
    }, {
      framework_gate: { combinations_tested: 50 },
      status_counts: { Robust: 10, Promising: 20, Weak: 15, Rejected: 5 },
    });

    assert.ok(errors.some((error) => error.path === "review_summary"));
  });
});
