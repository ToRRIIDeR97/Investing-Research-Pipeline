import assert from "node:assert/strict";
import test from "node:test";
import {
  createSourceReaderBatches,
  mergeSourceReaderOutputs,
  sourceReaderBatchFingerprint,
  type SourceReaderChunk,
} from "../src/lib/research/source-reader-batching";

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

test("source-reader task fingerprints reuse identical corpora and invalidate changed batches", () => {
  const first = createSourceReaderBatches([chunk(0), chunk(1)])[0];
  const same = createSourceReaderBatches([chunk(0), chunk(1)])[0];
  const changedChunk = chunk(1);
  changedChunk.content_excerpt = `${changedChunk.content_excerpt} new source material`;
  const changed = createSourceReaderBatches([chunk(0), changedChunk])[0];
  assert.equal(sourceReaderBatchFingerprint(first), sourceReaderBatchFingerprint(same));
  assert.notEqual(sourceReaderBatchFingerprint(first), sourceReaderBatchFingerprint(changed));
});

test("source-reader merge rejects invented citations and deduplicates valid claims", () => {
  const batches = createSourceReaderBatches([chunk(0), chunk(1)], { maxChunks: 1 });
  const valid = {
    claim_text: "A sufficiently detailed decision-relevant source claim.",
    source_id: "source-0",
    document_chunk_id: "chunk-0",
    char_start: 0,
    char_end: 100,
  };
  const invalidId = { ...valid, claim_text: "Another sufficiently detailed claim with a bad citation.", document_chunk_id: "invented" };
  const invalidRange = { ...valid, claim_text: "Another sufficiently detailed claim with a bad range.", char_end: 9_999 };
  const merged = mergeSourceReaderOutputs([
    { evidence_claims: [valid, valid, invalidId], contradictions: [{ message: "one" }] },
    { evidence_claims: [invalidRange], contradictions: [{ message: "one" }] },
  ], batches);
  assert.equal(merged.evidence_claims.length, 1);
  assert.equal(merged.rejected_invalid_citations.length, 2);
  assert.equal(merged.contradictions.length, 1);
  assert.equal(merged.evidence_claims[0].confidence, 0.75);
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
      char_start: 100,
      char_end: 155,
      confidence: 1,
    }],
  }], batches);
  assert.equal(merged.evidence_claims[0].char_start, 107);
  assert.equal(merged.evidence_claims[0].char_end, 148);
  assert.equal(merged.evidence_claims[0].confidence, 0.9);
});
