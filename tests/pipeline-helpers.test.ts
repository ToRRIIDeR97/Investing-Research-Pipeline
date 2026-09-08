import assert from "node:assert/strict";
import test from "node:test";
import { canonicalMetricPlan, ensureFilingFamilyCoverage, evidenceRelevantToModule, moduleCompletion, normalizeSourceGap, positiveFiniteNumber, reconcileMetricObservations, selectLatestFact, selectRelevantChunks, selectScopedRelevantChunks } from "../src/lib/research/pipeline-helpers";
import { isApprovedHumanDecision, isKnownHumanDecision } from "../src/lib/workflow/orchestrator";
import { inferMissingSourceCoverage } from "../src/lib/workflow/quality-gates";
import { reviewCoverageItems } from "../src/lib/workflow/validators";

test("annual fact selection rejects quarterly facts filed on a 10-K", () => {
  const selected = selectLatestFact([
    { val: 99, start: "2025-10-01", end: "2025-12-31", filed: "2026-02-01", form: "10-K", fp: "FY" },
    { val: 400, start: "2025-01-01", end: "2025-12-31", filed: "2026-02-01", form: "10-K", fp: "FY" },
  ], true);
  assert.equal(selected?.val, 400);
});

test("chunk selection retrieves relevant middle-document evidence with locators", () => {
  const chunks = Array.from({ length: 5 }, (_, index) => ({
    id: `c${index}`, sourceId: "s1", parseId: "p1", chunkIndex: index,
    charStart: index * 100, charEnd: index * 100 + 99, sourceTitle: "10-K", sourceType: "filing",
    text: index === 2 ? "Credit losses and provisions for the loan book" : `generic ${index}`,
  }));
  const selected = selectRelevantChunks(chunks, ["credit losses", "loan book"], 2);
  assert.deepEqual(selected.map((chunk) => chunk.id), ["c0", "c2"]);
  assert.equal(selected[1].charStart, 200);
});

test("many source openings cannot crowd relevant middle-document evidence out of the packet", () => {
  const chunks = Array.from({ length: 25 }, (_, sourceIndex) => [0, 1].map((chunkIndex) => ({
    id: `s${sourceIndex}-c${chunkIndex}`,
    sourceId: `s${String(sourceIndex).padStart(2, "0")}`,
    parseId: `p${sourceIndex}`,
    chunkIndex,
    charStart: chunkIndex * 100,
    charEnd: chunkIndex * 100 + 99,
    sourceTitle: `Filing ${sourceIndex}`,
    sourceType: "filing",
    text: sourceIndex === 24 && chunkIndex === 1
      ? "Detailed credit losses, loan book provisions, and customer funds"
      : `generic opening or body ${sourceIndex}-${chunkIndex}`,
  }))).flat();
  const selected = selectRelevantChunks(chunks, ["credit losses", "loan book", "customer funds"], 25);
  assert.equal(selected.length, 25);
  assert.ok(selected.some((chunk) => chunk.id === "s24-c1"));
  assert.ok(selected.filter((chunk) => chunk.chunkIndex === 0).length < selected.length);
});

test("scoped retrieval keeps member and segment contribution evidence from competing", () => {
  const chunks = [
    { id: "members", sourceId: "q1", parseId: "p1", chunkIndex: 1, charStart: 100, charEnd: 200, sourceTitle: "Q1", sourceType: "10-q", text: "Total members reached 10 million." },
    { id: "products", sourceId: "q2", parseId: "p2", chunkIndex: 1, charStart: 100, charEnd: 200, sourceTitle: "Q2", sourceType: "10-q", text: "Total products reached 15 million." },
    { id: "contribution", sourceId: "q3", parseId: "p3", chunkIndex: 1, charStart: 100, charEnd: 200, sourceTitle: "Q3", sourceType: "10-q", text: "Financial Services contribution margin was 45%." },
  ];
  const selected = selectScopedRelevantChunks(chunks, [
    { key: "engagement", terms: ["members", "total products"], maxChunks: 2 },
    { key: "segments", terms: ["contribution margin"], maxChunks: 1 },
  ]);
  assert.deepEqual(new Set(selected.map((chunk) => chunk.id)), new Set(["members", "products", "contribution"]));
  assert.deepEqual(selected.find((chunk) => chunk.id === "contribution")?.retrievalScopes, ["segments"]);
});

test("filing-family coverage retains annual and quarterly primary filings", () => {
  const chunks = [
    { id: "a", sourceId: "annual", parseId: "p", chunkIndex: 0, charStart: 0, charEnd: 10, text: "annual revenue", sourceTitle: "10-K", sourceType: "sec_filing_10-k" },
    { id: "q", sourceId: "quarter", parseId: "p", chunkIndex: 0, charStart: 0, charEnd: 10, text: "quarter credit", sourceTitle: "10-Q", sourceType: "sec_filing_10-q" },
    { id: "e", sourceId: "earnings", parseId: "p", chunkIndex: 0, charStart: 0, charEnd: 10, text: "earnings", sourceTitle: "8-K", sourceType: "sec_filing_8-k" },
  ];
  const covered = ensureFilingFamilyCoverage([chunks[2]], chunks, ["revenue", "credit"], 3);
  assert.deepEqual(new Set(covered.map((chunk) => chunk.sourceType)), new Set(["sec_filing_10-k", "sec_filing_10-q", "sec_filing_8-k"]));
});

test("positive finite metrics reject null, zero, and negative values", () => {
  assert.equal(positiveFiniteNumber(null), null);
  assert.equal(positiveFiniteNumber(0), null);
  assert.equal(positiveFiniteNumber(-1), null);
  assert.equal(positiveFiniteNumber("12.5"), 12.5);
});

test("metric reconciliation preserves dimensions and rejects conflicting alternatives", () => {
  const base = { metric_key: "revenue", period_start: "2025-01-01", period_end: "2025-12-31", unit: "USD", currency: "USD" };
  const result = reconcileMetricObservations([{ ...base, value_numeric: 20 }], [
    { ...base, value_numeric: 29 },
    { ...base, period_end: "2024-12-31", value_numeric: 18 },
  ]);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.accepted[0].value_numeric, 20);
});

test("canonical metric plan promotes the selected value and demotes stale accepted conflicts", () => {
  const plan = canonicalMetricPlan([
    { id: "old", value_numeric: "20", review_status: "accepted" },
    { id: "new", value_numeric: "29", review_status: "rejected" },
  ], "29");
  assert.equal(plan.promoteId, "new");
  assert.deepEqual(plan.demoteIds, ["old"]);
  assert.equal(plan.insert, false);
});

test("source gap normalization accepts gap/detail agent output", () => {
  assert.deepEqual(normalizeSourceGap({ gap: "Missing credit data", detail: "Loan loss vintages are absent", severity: "HIGH" }, "system:test"), {
    gapKey: "missing_credit_data", description: "Loan loss vintages are absent", severity: "high",
  });
});

test("module completion requires substantive module-specific provenance", () => {
  assert.equal(moduleCompletion({ summary: "generic", evidence: [] }).status, "needs_more_work");
  assert.equal(moduleCompletion({ summary: "A".repeat(90), evidence: ["claim-id"] }).status, "completed");
});

test("unrelated revenue evidence cannot complete provisions or loan-book modules", () => {
  const revenue = { claim_text: "Annual revenue increased 30% year over year", claim_type: "financial_fact", claim_category: "income_statement" };
  assert.equal(evidenceRelevantToModule("provisions", revenue), false);
  assert.equal(evidenceRelevantToModule("loan_book", revenue), false);
  assert.equal(evidenceRelevantToModule("provisions", { claim_text: "Credit loss provisions increased with the loan portfolio" }), true);
});

test("MELI module evidence terms recognize disclosed commerce, customer-fund, and funding facts", () => {
  assert.equal(evidenceRelevantToModule("revenue_drivers", { claim_text: "Gross Merchandise Volume reached $19.9 billion" }), true);
  assert.equal(evidenceRelevantToModule("margins", { claim_text: "Income from operations was $825 million with a 12.2% margin" }), true);
  assert.equal(evidenceRelevantToModule("customer_funds", { claim_text: "Assets under management reached $13.8 billion" }), true);
  assert.equal(evidenceRelevantToModule("funding_liabilities", { claim_text: "Current loans payable and financial liabilities were $5.3 billion" }), true);
  assert.equal(evidenceRelevantToModule("active_buyers", { claim_text: "Gross Merchandise Volume reached $19.9 billion" }), false);
});

test("human approval uses an explicit allowlist", () => {
  assert.equal(isApprovedHumanDecision("approved_for_tracking"), true);
  assert.equal(isApprovedHumanDecision("approved_for_position"), true);
  assert.equal(isApprovedHumanDecision("approved_by_system"), false);
  assert.equal(isKnownHumanDecision("watchlist"), true);
  assert.equal(isKnownHumanDecision("approved_by_system"), false);
});

test("AI review validation excludes the future human decision gate", () => {
  const items = [{ area: "AI review", key: "ai" }, { area: "human review", key: "human" }];
  assert.deepEqual(reviewCoverageItems(items, "AI review").map((item) => item.key), ["ai"]);
  assert.deepEqual(reviewCoverageItems(items, "human review").map((item) => item.key), ["human"]);
});

test("valuation coverage requires a numeric scenario anchor", () => {
  const base = {
    runType: "deep_dive",
    sources: [
      { source_type: "sec_filing" },
      { source_type: "investor_relations" },
      { source_type: "peer_industry" },
      { source_type: "sec_filing" },
      { source_type: "investor_relations" },
    ],
    evidence: Array.from({ length: 25 }, () => ({})),
  };
  const invalid = inferMissingSourceCoverage({ ...base, scenarios: [{ value_anchor: "not calculated" }] });
  const numeric = inferMissingSourceCoverage({ ...base, scenarios: [{ value_anchor: "4250.00" }] });
  assert.ok(invalid.some((item) => item.key === "valuation_anchors"));
  assert.ok(!numeric.some((item) => item.key === "valuation_anchors"));
});

test("quarterly reconciliation flags material annual discrepancies and demotes them", () => {
  const common = { metric_key: "revenue", currency: "USD", unit: "USD" };
  const Q1 = { ...common, period_start: "2025-01-01", period_end: "2025-03-31", value_numeric: 500 };
  const Q2 = { ...common, period_start: "2025-04-01", period_end: "2025-06-30", value_numeric: 600 };
  const Q3 = { ...common, period_start: "2025-07-01", period_end: "2025-09-30", value_numeric: 700 };
  const Q4 = { ...common, period_start: "2025-10-01", period_end: "2025-12-31", value_numeric: 800 };
  
  // Annual is 2600. Sum of quarters is 2600. No conflict.
  const consistentAnnual = { ...common, period_start: "2025-01-01", period_end: "2025-12-31", value_numeric: 2600 };
  
  // Annual is 3000. Difference is 400 (which exceeds tolerance of max(10M, 30)). Conflict!
  const inconsistentAnnual = { ...common, period_start: "2025-01-01", period_end: "2025-12-31", value_numeric: 3000 };

  const resultOk = reconcileMetricObservations([consistentAnnual, Q1, Q2, Q3, Q4], []);
  assert.equal(resultOk.accepted.length, 5);
  assert.equal(resultOk.conflicts.length, 0);

  const resultErr = reconcileMetricObservations([inconsistentAnnual, Q1, Q2, Q3, Q4], []);
  // Inconsistent annual is demoted/deleted, so only 4 quarters are accepted
  assert.equal(resultErr.accepted.length, 4);
  assert.equal(resultErr.conflicts.length, 1);
  assert.equal(resultErr.conflicts[0].rejected_value, 3000);
  assert.equal(resultErr.conflicts[0].accepted_value, 2600);
});
