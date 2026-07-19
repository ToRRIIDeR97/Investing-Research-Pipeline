export const SOURCE_READER_OUTPUT_KEYS = [
  "evidence_claims",
  "contradictions",
  "source_gaps",
  "low_confidence_items",
  "rejected_candidates",
] as const;

export interface SourceReaderChunk {
  source_id: string;
  document_parse_id?: string;
  document_chunk_id: string;
  source_type?: string;
  source_role?: string;
  title?: string;
  section_title?: string;
  chunk_index?: number;
  char_start?: number;
  char_end?: number;
  content_excerpt: string;
}

export interface SourceReaderBatch {
  id: string;
  chunks: SourceReaderChunk[];
  estimatedInputTokens: number;
  inputBytes: number;
}

export interface SourceReaderBatchOptions {
  maxChunks?: number;
  maxBytes?: number;
}

export function sourceReaderBatchFingerprint(batch: SourceReaderBatch): string {
  return createHash("sha256")
    .update(JSON.stringify(batch.chunks))
    .digest("hex")
    .slice(0, 12);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function chunkBytes(chunk: SourceReaderChunk) {
  return Buffer.byteLength(JSON.stringify(chunk), "utf8");
}

/** Partition in retrieval order so batch keys and resume behavior remain stable. */
export function createSourceReaderBatches(
  chunks: SourceReaderChunk[],
  options: SourceReaderBatchOptions = {}
): SourceReaderBatch[] {
  const maxChunks = Math.max(1, options.maxChunks ?? 8);
  const maxBytes = Math.max(4_000, options.maxBytes ?? 36_000);
  const batches: SourceReaderChunk[][] = [];
  let current: SourceReaderChunk[] = [];
  let currentBytes = 0;

  for (const chunk of chunks) {
    const bytes = chunkBytes(chunk);
    if (current.length && (current.length >= maxChunks || currentBytes + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(chunk);
    currentBytes += bytes;
  }
  if (current.length) batches.push(current);

  return batches.map((batchChunks, index) => {
    const inputBytes = Buffer.byteLength(JSON.stringify(batchChunks), "utf8");
    return {
      id: String(index + 1).padStart(2, "0"),
      chunks: batchChunks,
      inputBytes,
      estimatedInputTokens: Math.ceil(inputBytes / 4),
    };
  });
}

function normalizedText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function claimKey(claim: Record<string, unknown>) {
  return [
    String(claim.source_id || claim.source_document_id || ""),
    String(claim.document_chunk_id || claim.chunk_id || ""),
    normalizedText(claim.claim_text || claim.text || claim.claim),
    String(claim.period_end || claim.as_of_date || ""),
  ].join("|");
}

function normalizedClaim(claim: Record<string, unknown>, chunks: Map<string, SourceReaderChunk>) {
  const sourceId = String(claim.source_id || claim.source_document_id || "");
  const chunkId = String(claim.document_chunk_id || claim.chunk_id || "");
  const chunk = chunks.get(chunkId);
  if (!chunk || chunk.source_id !== sourceId) return null;
  const claimText = String(claim.claim_text || claim.text || claim.claim || "").trim();
  if (claimText.length < 20) return null;

  const quote = typeof claim.quoted_text === "string" ? claim.quoted_text.trim() : "";
  const quoteOffset = quote.length >= 10 ? chunk.content_excerpt.indexOf(quote) : -1;
  if (quoteOffset >= 0) {
    const start = Number(chunk.char_start || 0) + quoteOffset;
    return {
      ...claim,
      char_start: start,
      char_end: start + quote.length,
      confidence: Math.min(0.9, Number.isFinite(Number(claim.confidence)) ? Number(claim.confidence) : 0.75),
    };
  }

  const start = Number(claim.char_start);
  const end = Number(claim.char_end);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    const chunkStart = Number(chunk.char_start ?? 0);
    const chunkEnd = Number(chunk.char_end ?? chunkStart + chunk.content_excerpt.length);
    if (start < chunkStart || end > chunkEnd || end <= start) return null;
  }
  return {
    ...claim,
    confidence: Math.min(0.85, Number.isFinite(Number(claim.confidence)) ? Number(claim.confidence) : 0.75),
  };
}

export interface MergedSourceReaderOutput extends Record<string, unknown> {
  evidence_claims: Record<string, unknown>[];
  contradictions: Record<string, unknown>[];
  source_gaps: Record<string, unknown>[];
  low_confidence_items: Record<string, unknown>[];
  rejected_candidates: Record<string, unknown>[];
  rejected_invalid_citations: Record<string, unknown>[];
}

export function mergeSourceReaderOutputs(
  outputs: Record<string, unknown>[],
  batches: SourceReaderBatch[]
): MergedSourceReaderOutput {
  const chunks = new Map(
    batches.flatMap((batch) => batch.chunks).map((chunk) => [chunk.document_chunk_id, chunk] as const)
  );
  const accepted: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const output of outputs) {
    for (const claim of records(output.evidence_claims)) {
      const normalized = normalizedClaim(claim, chunks);
      if (!normalized) {
        rejected.push(claim);
        continue;
      }
      const key = claimKey(normalized);
      if (!seen.has(key)) {
        seen.add(key);
        accepted.push(normalized);
      }
    }
  }

  const mergeList = (key: string) => {
    const values = outputs.flatMap((output) => records(output[key]));
    const unique = new Map(values.map((value) => [normalizedText(value.message || value.description || value.claim_text || JSON.stringify(value)), value]));
    return [...unique.values()];
  };

  return {
    evidence_claims: accepted,
    contradictions: mergeList("contradictions"),
    source_gaps: mergeList("source_gaps"),
    low_confidence_items: mergeList("low_confidence_items"),
    rejected_candidates: mergeList("rejected_candidates"),
    rejected_invalid_citations: rejected,
  };
}
import { createHash } from "node:crypto";
