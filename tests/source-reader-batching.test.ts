import assert from "node:assert/strict";
import test from "node:test";
import {
  createSourceReaderBatches,
  evaluateEvidenceCoverage,
  extractDeterministicEvidence,
  mergeSourceReaderOutputs,
  planEvidenceBatches,
  sourceReaderBatchFingerprint,
  type SourceReaderChunk,
} from "../src/lib/research/source-reader-batching";
import type { EvidenceCoverageSlot } from "../src/lib/research/archetypes/types";
import { buildSourceReaderPrompt } from "../src/lib/research/handlers/evidence-extraction";
import { rejectedOutputPayload } from "../src/lib/research/run-context";

function chunk(index: number, size = 1_000): SourceReaderChunk {
  return {
    source_id: `source-${Math.floor(index / 2)}`,
    document_parse_id: `parse-${index}`,
    document_chunk_id: `chunk-${index}`,
    chunk_index: index,
    char_start: index * 2_000,
    char_end: index * 2_000 + size,
    content_excerpt: "x".repeat(size),
  };
}

test("source-reader batching is stable and obeys chunk and byte ceilings", () => {
  const chunks = Array.from({ length: 7 }, (_, index) => chunk(index));
  const first = createSourceReaderBatches(chunks, { maxChunks: 3, maxBytes: 10_000 });
  const second = createSourceReaderBatches(chunks, { maxChunks: 3, maxBytes: 10_000 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((batch) => batch.id), ["01", "02", "03"]);
  assert.deepEqual(first.map((batch) => batch.chunks.length), [3, 3, 1]);
  assert.ok(first.every((batch) => batch.inputBytes <= 10_000));
});

test("coverage planner prioritizes mandatory slots and enforces batch and text budgets", () => {
  const slots: EvidenceCoverageSlot[] = [
    { key: "members_by_period", priority: "mandatory", retrievalQueries: ["members"], preferredSourceRoles: ["earnings_release"], preferredSourceTypes: [], minimumAcceptedClaims: 1 },
    { key: "optional_story", priority: "optional", retrievalQueries: ["story"], preferredSourceRoles: [], preferredSourceTypes: [], minimumAcceptedClaims: 1 },
  ];
  const chunks = [
    { ...chunk(0, 1_000), content_excerpt: `story ${"x".repeat(994)}` },
    { ...chunk(1, 1_000), source_role: "earnings_release", content_excerpt: `members ${"x".repeat(992)}` },
    ...Array.from({ length: 20 }, (_, index) => ({ ...chunk(index + 2, 1_000), content_excerpt: `story ${"x".repeat(994)}` })),
  ];
  const plan = planEvidenceBatches(chunks, slots, { maxChunks: 1, maxBytes: 4_000, maxBatches: 2, maxCharacters: 2_000 });
  assert.equal(plan.batches.length, 2);
  assert.ok(plan.batches[0].coverageSlotKeys?.includes("members_by_period"));
  assert.ok(plan.selectedCharacters <= 2_000);
  assert.deepEqual(plan.uncoveredMandatorySlotKeys, []);
});

test("coverage evaluation requires claim and period minima", () => {
  const slots: EvidenceCoverageSlot[] = [{
    key: "members_by_period", priority: "mandatory", retrievalQueries: ["members"],
    preferredSourceRoles: [], preferredSourceTypes: [], minimumAcceptedClaims: 2,
    periodCoverage: { minimumPeriods: 2, periodicity: "quarterly" },
  }];
  const coverage = evaluateEvidenceCoverage(slots, [
    { claim_text: "Members reached 8 million", period_end: "2025-03-31" },
    { claim_text: "Members reached 9 million", period_end: "2025-06-30" },
  ]);
  assert.equal(coverage[0].status, "satisfied");
  assert.equal(coverage[0].periodCount, 2);
});

test("source-reader task fingerprints reuse identical inputs and invalidate changed batches or targets", () => {
  const first = createSourceReaderBatches([chunk(0), chunk(1)])[0];
  const same = createSourceReaderBatches([chunk(0), chunk(1)])[0];
  const changedChunk = chunk(1);
  changedChunk.content_excerpt = `${changedChunk.content_excerpt} new source material`;
  const changed = createSourceReaderBatches([chunk(0), changedChunk])[0];
  assert.equal(sourceReaderBatchFingerprint(first), sourceReaderBatchFingerprint(same));
  assert.notEqual(sourceReaderBatchFingerprint(first), sourceReaderBatchFingerprint(changed));
  assert.notEqual(sourceReaderBatchFingerprint(first, 5), sourceReaderBatchFingerprint(first, 10));
});

test("source-reader merge rejects invented citations and deduplicates valid claims", () => {
  const batches = createSourceReaderBatches([chunk(0), chunk(1)], { maxChunks: 1 });
  const valid = {
    claim_text: "A sufficiently detailed decision-relevant source claim.",
    source_id: "source-0",
    document_chunk_id: "chunk-0",
    quoted_text: "xxxxxxxxxxxxxxxxxxxx",
    char_start: 0,
    char_end: 20,
  };
  const invalidId = { ...valid, claim_text: "Another sufficiently detailed claim with a bad citation.", document_chunk_id: "invented" };
  const invalidRange = { ...valid, claim_text: "Another sufficiently detailed claim with a bad range.", char_end: 9_999 };
  const merged = mergeSourceReaderOutputs([
    {
      evidence_claims: [valid, valid, invalidId],
      contradictions: [{ message: "one" }],
      source_gaps: [{ description: "This batch does not contain another batch's source." }],
    },
    { evidence_claims: [invalidRange], contradictions: [{ message: "one" }] },
  ], batches);
  assert.equal(merged.evidence_claims.length, 1);
  assert.equal(merged.rejected_invalid_citations.length, 2);
  assert.equal(merged.contradictions.length, 1);
  assert.equal(merged.source_gaps.length, 1);
  assert.equal(merged.evidence_claims[0].confidence, 0.75);
});

test("source-reader merge separates malformed claims from proven citation failures", () => {
  const source = chunk(0);
  const validCitation = {
    source_id: source.source_id,
    document_chunk_id: source.document_chunk_id,
    quoted_text: "xxxxxxxxxxxxxxxxxxxx",
    char_start: 0,
    char_end: 20,
  };
  const merged = mergeSourceReaderOutputs([{
    evidence_claims: [
      { ...validCitation, claim_text: "short" },
      { ...validCitation, claim_text: "A sufficiently detailed claim with an invented source.", source_id: "invented" },
    ],
  }], createSourceReaderBatches([source]));
  assert.equal(merged.rejected_invalid_claims[0].rejection_reason, "missing_or_invalid_claim_text");
  assert.equal(merged.rejected_invalid_citations[0].rejection_reason, "unknown_source_id");
});

test("source-reader canary reuses the production prompt and retains rejected attempt evidence", () => {
  const prompt = buildSourceReaderPrompt({ source_corpus: [] }, 4);
  assert.match(prompt, /claim_text, claim_type, claim_category, source_id, document_chunk_id, quoted_text, char_start, char_end/);
  assert.match(prompt, /Return up to 4 distinct/);

  const attempt = {
    attempt: 1,
    provider: "fixture",
    model: "fixture-model",
    requestId: "request-1",
    status: "failed",
    errorCategory: "schema_validation",
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.01,
    latencyMs: 30,
    repairAttempted: false,
    validationErrors: [{ path: "evidence_claims[0].claim_text", message: "Required property is missing" }],
    rawResponseExcerpt: '{"evidence_claims":[{}]}',
  };
  const error = Object.assign(new Error("schema failed"), {
    responseMetadata: { raw_response_excerpt: attempt.rawResponseExcerpt, attempts: [attempt] },
    attempts: [attempt],
  });
  const payload = rejectedOutputPayload(error);
  assert.equal(payload.raw_response_excerpt, attempt.rawResponseExcerpt);
  assert.equal(payload.attempts[0].request_id, "request-1");
  assert.deepEqual(payload.validation_errors, attempt.validationErrors);
});

test("deterministic extraction captures exact member and segment rows with provenance", () => {
  const source = chunk(0);
  source.content_excerpt = [
    "Total Members 9,000,000 as of 2025-06-30",
    "Technology Platform contribution profit was $120 million in 2025-06-30.",
  ].join("\n");
  const claims = extractDeterministicEvidence([source]);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].quoted_text, "Total Members 9,000,000 as of 2025-06-30");
  assert.equal(claims[0].period_end, "2025-06-30");
  assert.equal(claims[1].document_chunk_id, source.document_chunk_id);
});

test("source-reader merge derives precise locators from exact quotes and caps confidence", () => {
  const source = chunk(0);
  source.content_excerpt = "prefix Exact supporting quotation for the claim. suffix";
  source.char_start = 100;
  source.char_end = 155;
  const batches = createSourceReaderBatches([source]);
  const merged = mergeSourceReaderOutputs([{
    evidence_claims: [{
      claim_text: "A sufficiently detailed decision-relevant source claim.",
      source_id: source.source_id,
      document_chunk_id: source.document_chunk_id,
      quoted_text: "Exact supporting quotation for the claim.",
      char_start: 107,
      char_end: 148,
      confidence: 1,
    }],
  }], batches);
  assert.equal(merged.evidence_claims[0].char_start, 107);
  assert.equal(merged.evidence_claims[0].char_end, 148);
  assert.equal(merged.evidence_claims[0].confidence, 0.9);
});

test("source-reader merge repairs in-bounds offsets when the exact quote locates unambiguously", () => {
  const source = chunk(0);
  source.content_excerpt = "prefix Exact supporting quotation for the claim. suffix";
  source.char_start = 100;
  source.char_end = 155;
  const merged = mergeSourceReaderOutputs([{
    evidence_claims: [{
      claim_text: "A sufficiently detailed decision-relevant source claim.",
      source_id: source.source_id,
      document_chunk_id: source.document_chunk_id,
      quoted_text: "Exact supporting quotation for the claim.",
      char_start: 101,
      char_end: 140,
    }],
  }], createSourceReaderBatches([source]));
  assert.equal(merged.evidence_claims.length, 1);
  assert.equal(merged.evidence_claims[0].char_start, 107);
  assert.equal(merged.evidence_claims[0].char_end, 148);
  assert.equal(merged.evidence_claims[0].citation_repaired, true);
});
