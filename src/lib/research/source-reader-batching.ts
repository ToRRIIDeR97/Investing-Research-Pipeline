import { createHash } from "node:crypto";
import type { EvidenceCoverageSlot } from "./archetypes/types";

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
  retrieval_scopes?: string[];
  title?: string;
  section_title?: string;
  chunk_index?: number;
  char_start?: number;
  char_end?: number;
  content_excerpt: string;
  source_period_end?: string | null;
}

export interface SourceReaderBatch {
  id: string;
  chunks: SourceReaderChunk[];
  estimatedInputTokens: number;
  inputBytes: number;
  coverageSlotKeys?: string[];
}

export interface SourceReaderBatchOptions {
  maxChunks?: number;
  maxBytes?: number;
}

const SOURCE_READER_CONTRACT_VERSION = "citation-v4-focused";

export function sourceReaderBatchFingerprint(batch: SourceReaderBatch, claimTarget?: number): string {
  return createHash("sha256")
    .update(JSON.stringify({
      contractVersion: SOURCE_READER_CONTRACT_VERSION,
      chunks: batch.chunks,
      coverageSlotKeys: batch.coverageSlotKeys || [],
      claimTarget,
    }))
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
  const maxChunks = Math.max(1, options.maxChunks ?? 4);
  const maxBytes = Math.max(4_000, options.maxBytes ?? 16_000);
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

const SLOT_SCOPE_ALIASES: Record<string, string[]> = {
  consolidated_financials: ["financial_statements"],
  management_guidance: ["valuation_inputs"],
  founder_and_company_history: ["company_history"],
  members_by_period: ["member_and_product_growth"],
  products_by_period: ["member_and_product_growth"],
  cross_buy: ["member_and_product_growth"],
  lending_segment: ["segment_economics"],
  technology_platform_segment: ["segment_economics"],
  financial_services_segment: ["segment_economics"],
  loans_and_credit: ["credit_and_funding"],
  funding_cost: ["credit_and_funding"],
  deposits_and_capital: ["credit_and_funding", "capital_and_dilution"],
};

function queryMatches(text: string, query: string) {
  const normalized = normalizedText(query);
  if (!normalized) return false;
  if (text.includes(normalized)) return true;
  const words = normalized.split(" ").filter((word) => word.length > 2);
  return words.length > 1 && words.every((word) => text.includes(word));
}

export function coverageSlotsForChunk(chunk: SourceReaderChunk, slots: EvidenceCoverageSlot[]) {
  const scopes = new Set(chunk.retrieval_scopes || []);
  const text = normalizedText([
    chunk.title,
    chunk.section_title,
    chunk.source_role,
    chunk.source_type,
    chunk.content_excerpt,
  ].filter(Boolean).join(" "));
  return slots.filter((slot) =>
    (SLOT_SCOPE_ALIASES[slot.key] || []).some((scope) => scopes.has(scope)) ||
    slot.retrievalQueries.some((query) => queryMatches(text, query))
  ).map((slot) => slot.key);
}

export interface EvidenceBatchPlan {
  batches: SourceReaderBatch[];
  selectedCharacters: number;
  selectedBytes: number;
  coveredSlotKeys: string[];
  uncoveredMandatorySlotKeys: string[];
}

export function planEvidenceBatches(
  chunks: SourceReaderChunk[],
  slots: EvidenceCoverageSlot[],
  options: SourceReaderBatchOptions & { maxBatches?: number; maxCharacters?: number } = {}
): EvidenceBatchPlan {
  const maxBatches = Math.max(1, options.maxBatches ?? 8);
  const maxCharacters = Math.max(1, options.maxCharacters ?? 80_000);
  const excerptKey = (chunk: SourceReaderChunk) => `${chunk.document_chunk_id}:${chunk.char_start}:${chunk.char_end}`;
  const unique = [...new Map(chunks.map((chunk) => [excerptKey(chunk), chunk])).values()];
  const selected: SourceReaderChunk[] = [];
  const selectedIds = new Set<string>();
  const coverageCounts = new Map<string, number>();
  const priorityWeight = { mandatory: 100, important: 10, optional: 1 } as const;
  let selectedCharacters = 0;

  while (true) {
    const candidate = unique
      .filter((chunk) => !selectedIds.has(excerptKey(chunk)))
      .map((chunk, index) => {
        const slotKeys = coverageSlotsForChunk(chunk, slots);
        const gain = slotKeys.reduce((sum, key) => {
          const slot = slots.find((item) => item.key === key)!;
          return sum + ((coverageCounts.get(key) || 0) < slot.minimumAcceptedClaims ? priorityWeight[slot.priority] : 0);
        }, 0);
        const preferred = slots.some((slot) => slotKeys.includes(slot.key) && (
          slot.preferredSourceRoles.includes(chunk.source_role || "") ||
          slot.preferredSourceTypes.includes(chunk.source_type || "")
        ));
        return { chunk, index, slotKeys, score: (gain + (preferred ? 0.5 : 0)) / Math.max(1, chunkBytes(chunk)) };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (!candidate) break;
    selectedIds.add(excerptKey(candidate.chunk));
    if (selectedCharacters + candidate.chunk.content_excerpt.length > maxCharacters) continue;
    if (focusedBatches([...selected, candidate.chunk], slots, options).length > maxBatches) continue;
    selected.push(candidate.chunk);
    selectedCharacters += candidate.chunk.content_excerpt.length;
    for (const key of candidate.slotKeys) coverageCounts.set(key, (coverageCounts.get(key) || 0) + 1);
  }

  const batches = focusedBatches(selected, slots, options).map((batch, index) => ({
    ...batch,
    id: String(index + 1).padStart(2, "0"),
    coverageSlotKeys: [...new Set(batch.chunks.flatMap((chunk) => coverageSlotsForChunk(chunk, slots)))].sort(),
  }));
  const coveredSlotKeys = slots.filter((slot) => (coverageCounts.get(slot.key) || 0) > 0).map((slot) => slot.key);
  return {
    batches,
    selectedCharacters,
    selectedBytes: batches.reduce((sum, batch) => sum + batch.inputBytes, 0),
    coveredSlotKeys,
    uncoveredMandatorySlotKeys: slots
      .filter((slot) => slot.priority === "mandatory" && !coveredSlotKeys.includes(slot.key))
      .map((slot) => slot.key),
  };
}

function focusedBatches(chunks: SourceReaderChunk[], slots: EvidenceCoverageSlot[], options: SourceReaderBatchOptions) {
  const groups = new Map<string, SourceReaderChunk[]>();
  for (const chunk of chunks) {
    const keys = coverageSlotsForChunk(chunk, slots);
    const family = keys.some((key) => /founder|history/.test(key)) ? "history"
      : keys.some((key) => /members|products|cross_buy/.test(key)) ? "customers"
      : keys.some((key) => /segment/.test(key)) ? "segments"
      : keys.some((key) => /credit|funding|loans|deposits|capital/.test(key)) ? "credit_and_funding"
      : keys.some((key) => /guidance/.test(key)) ? "guidance" : "financials";
    const key = `${family}:${chunk.source_period_end || 'undated'}`;
    groups.set(key, [...(groups.get(key) || []), chunk]);
  }
  return [...groups.values()].flatMap((group) => createSourceReaderBatches(group, options));
}

export function evaluateEvidenceCoverage(slots: EvidenceCoverageSlot[], claims: Record<string, unknown>[]) {
  return slots.map((slot) => {
    const accepted = claims.filter((claim) => {
      const text = normalizedText(`${claim.claim_type || ""} ${claim.claim_text || ""}`);
      if (/<[^>]+>|&#?\w+;|\b(?:staff|board) members\b/i.test(text)) return false;
      return slot.retrievalQueries.some((query) => queryMatches(text, query));
    });
    const periods = new Set(accepted.map((claim) => String(claim.period_end || claim.as_of_date || "")).filter(Boolean));
    const satisfied = accepted.length >= slot.minimumAcceptedClaims &&
      (!slot.periodCoverage || periods.size >= slot.periodCoverage.minimumPeriods);
    return {
      key: slot.key,
      priority: slot.priority,
      status: satisfied ? "satisfied" as const : "missing" as const,
      acceptedClaimCount: accepted.length,
      periodCount: periods.size,
    };
  });
}

const DETERMINISTIC_EVIDENCE_PATTERNS = [
  ["members", /\btotal\s+members?\b|^members\s*(?:\||[\d,]+|reached|grew|increased|were|was)/i],
  ["total_products", /\btotal\s+products?\b/i],
  ["segment_contribution", /\b(?:lending|technology platform|financial services)\b.*\bcontribution\s+(?:profit|loss|margin)\b/i],
  ["consolidated_financial", /\b(?:revenue|adjusted EBITDA|net income|deposits?|loans?|capital ratio)\b/i],
] as const;
const REPORTING_PERIOD_PATTERN = /\b20\d{2}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/gi;

/** Extract exact numeric table rows and sentences before spending a model call. */
export function extractDeterministicEvidence(chunks: SourceReaderChunk[]) {
  const claims: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (/<[^>]+>|&#?\w+;/.test(chunk.content_excerpt)) continue;
    const parts = chunk.content_excerpt.split(/(?<=[.!?])\s+|\n+/);
    let searchFrom = 0;
    let header: { text: string; start: number; periods: string[] } | undefined;
    for (const part of parts) {
      const quote = part.trim();
      const localStart = chunk.content_excerpt.indexOf(quote, searchFrom);
      if (localStart >= 0) searchFrom = localStart + quote.length;
      const periods = reportingPeriods(quote);
      if (periods.length && !DETERMINISTIC_EVIDENCE_PATTERNS.some(([, pattern]) => pattern.test(quote))) {
        header = { text: quote, start: localStart, periods };
      }
      if (quote.length < 10 || quote.length > 600 || !/\d/.test(quote.replace(REPORTING_PERIOD_PATTERN, '')) || localStart < 0) continue;
      const matched = DETERMINISTIC_EVIDENCE_PATTERNS.find(([, pattern]) => pattern.test(quote));
      if (!matched) continue;
      if (/staff|board members|employees|commission|style\s*=|font-/i.test(quote)) continue;
      const inherited = header && localStart - header.start < 1500 ? header : undefined;
      const dates = periods.length ? periods : inherited?.periods || [];
      if (!dates.length) continue;
      const key = `${chunk.document_chunk_id}:${quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Multi-period tables need one value per dated column. Ambiguous rows go to the AI reader.
      const cells = quote.split(/\s*\|\s*/);
      if (dates.length > 1 && ((cells.length !== dates.length + 1 && !/\bvariance|\bchange/i.test(inherited?.text || ''))
        || cells.length < dates.length + 1 || !cells.slice(1, dates.length + 1).every((cell) => /^[$(\-\d]/.test(cell) && /\d/.test(cell)))) continue;
      const quoteStart = periods.length ? localStart : inherited!.start;
      const fullQuote = chunk.content_excerpt.slice(quoteStart, localStart + quote.length);
      const charStart = Number(chunk.char_start || 0) + quoteStart;
      for (const [index, period] of dates.entries()) {
      claims.push({
        claim_text: dates.length > 1 ? `${cells[0]}: ${cells[index + 1]} for ${period}.` : `${quote}${periods.length ? '' : ` for ${period}`}`,
        claim_type: matched[0],
        claim_category: "fact",
        source_id: chunk.source_id,
        document_chunk_id: chunk.document_chunk_id,
        quoted_text: fullQuote,
        char_start: charStart,
        char_end: charStart + fullQuote.length,
        ...(period ? { period_end: period } : {}),
        confidence: 0.9,
        generated_by: "deterministic-table-extractor",
      });
      }
    }
  }
  return claims;
}

export function reportingPeriods(text: string): string[] {
  const matches = text.match(REPORTING_PERIOD_PATTERN) || [];
  return [...new Set(matches.flatMap((value) => {
    const iso = /^20\d{2}-\d{2}-\d{2}$/.test(value);
    const date = new Date(iso ? `${value}T00:00:00Z` : `${value} UTC`);
    if (Number.isNaN(date.getTime())) return [];
    const result = date.toISOString().slice(0, 10);
    return iso && value !== result ? [] : [result];
  }))];
}

function claimKey(claim: Record<string, unknown>) {
  return [
    String(claim.source_id || claim.source_document_id || ""),
    String(claim.document_chunk_id || claim.chunk_id || ""),
    normalizedText(claim.claim_text || claim.text || claim.claim),
    String(claim.period_end || claim.as_of_date || ""),
  ].join("|");
}

type NormalizedClaimResult =
  | { claim: Record<string, unknown> }
  | { error: string; citationFailure: boolean };

function normalizedClaim(claim: Record<string, unknown>, chunks: SourceReaderChunk[]): NormalizedClaimResult {
  const sourceId = String(claim.source_id || claim.source_document_id || "");
  const chunkId = String(claim.document_chunk_id || claim.chunk_id || "");
  const claimText = String(claim.claim_text || claim.text || claim.claim || "").trim();
  const quote = typeof claim.quoted_text === "string" ? claim.quoted_text.trim() : "";
  const claimedStart = Number(claim.char_start);
  const claimedEnd = Number(claim.char_end);
  if (claimText.length < 20) return { error: "missing_or_invalid_claim_text", citationFailure: false } as const;
  if (!sourceId) return { error: "missing_source_id", citationFailure: false } as const;
  if (!chunkId) return { error: "missing_document_chunk_id", citationFailure: false } as const;
  if (quote.length < 10) return { error: "missing_or_invalid_quoted_text", citationFailure: false } as const;
  if (!Number.isFinite(claimedStart) || !Number.isFinite(claimedEnd)) {
    return { error: "missing_or_invalid_absolute_offsets", citationFailure: false } as const;
  }

  const sourceExists = chunks.some((item) => item.source_id === sourceId);
  if (!sourceExists) return { error: "unknown_source_id", citationFailure: true } as const;
  const chunkCandidates = chunks.filter((item) => item.document_chunk_id === chunkId);
  if (!chunkCandidates.length) return { error: "unknown_document_chunk_id", citationFailure: true } as const;
  const sourceChunks = chunkCandidates.filter((item) => item.source_id === sourceId);
  if (!sourceChunks.length) return { error: "source_chunk_mismatch", citationFailure: true } as const;
  const quoteChunks = sourceChunks.filter((item) => item.content_excerpt.includes(quote));
  if (!quoteChunks.length) return { error: "quoted_text_not_found", citationFailure: true } as const;
  const chunk = quoteChunks.find((item) => {
    const start = Number(item.char_start ?? 0);
    const end = Number(item.char_end ?? start + item.content_excerpt.length);
    return claimedStart >= start && claimedEnd <= end && claimedEnd > claimedStart;
  });
  if (!chunk) {
    return { error: "invalid_absolute_offsets", citationFailure: true } as const;
  }
  const quoteOffset = chunk.content_excerpt.indexOf(quote);
  const start = Number(chunk.char_start || 0) + quoteOffset;
  const end = start + quote.length;
  // Models often copy the quote correctly but calculate offsets against the
  // shortened excerpt instead of the absolute document chunk. The quote is
  // the authoritative locator; repair an in-bounds offset deterministically
  // while retaining rejection for invented chunks or out-of-bounds ranges.
  const repaired = Number.isFinite(claimedStart) && Number.isFinite(claimedEnd)
    && (claimedStart !== start || claimedEnd !== end);
  return {
    claim: {
      ...claim,
      char_start: start,
      char_end: end,
      ...(repaired ? { citation_repaired: true } : {}),
      confidence: Math.min(0.9, Number.isFinite(Number(claim.confidence)) ? Number(claim.confidence) : 0.75),
    },
  } as const;
}

export interface MergedSourceReaderOutput extends Record<string, unknown> {
  evidence_claims: Record<string, unknown>[];
  contradictions: Record<string, unknown>[];
  source_gaps: Record<string, unknown>[];
  low_confidence_items: Record<string, unknown>[];
  rejected_candidates: Record<string, unknown>[];
  rejected_invalid_claims: Record<string, unknown>[];
  rejected_invalid_citations: Record<string, unknown>[];
}

export function mergeSourceReaderOutputs(
  outputs: Record<string, unknown>[],
  batches: SourceReaderBatch[]
): MergedSourceReaderOutput {
  const chunks = batches.flatMap((batch) => batch.chunks);
  const accepted: Record<string, unknown>[] = [];
  const rejectedClaims: Record<string, unknown>[] = [];
  const rejectedCitations: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const output of outputs) {
    for (const claim of records(output.evidence_claims)) {
      const normalized = normalizedClaim(claim, chunks);
      if (!("claim" in normalized)) {
        const rejected = { ...claim, rejection_reason: normalized.error };
        (normalized.citationFailure ? rejectedCitations : rejectedClaims).push(rejected);
        continue;
      }
      const key = claimKey(normalized.claim);
      if (!seen.has(key)) {
        seen.add(key);
        accepted.push(normalized.claim);
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
    rejected_invalid_claims: rejectedClaims,
    rejected_invalid_citations: rejectedCitations,
  };
}
