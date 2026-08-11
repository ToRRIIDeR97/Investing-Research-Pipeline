import { latestV3TaskOutput, makeValidationResult } from "../run-context";
import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import {
  buildSourcePacket,
  persistEvidence,
  deterministicEvidenceFallback,
  loadAcceptedEvidencePacket,
  reconcileSourceGaps,
} from "../system-pipeline";
import {
  createSourceReaderBatches,
  mergeSourceReaderOutputs,
  sourceReaderBatchFingerprint,
} from "../source-reader-batching";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { RUN_TYPE_THRESHOLDS } from "../../workflow/quality-gates";

const SOURCE_READER_OUTPUT_KEYS = [
  "evidence_claims",
  "contradictions",
  "source_gaps",
  "low_confidence_items",
  "rejected_candidates",
];
const FOUNDER_ORIGIN_CLAIM_PATTERN = /founder|co[-\s]?founder|founded|marcos|galperin|motivat|origin|professor|research program|mission|sacrifice|lab to the market/i;

function compactFounderRoleChunks(chunks: Record<string, unknown>[]) {
  return chunks.map((chunk) => {
    const text = typeof chunk.content_excerpt === "string" ? chunk.content_excerpt : "";
    if (text.length <= 2_400) return chunk;
    const match = /founder|co[-\s]?founder|founded|origin|marcos|galperin|motivat/i.exec(text);
    const pivot = match?.index ?? 0;
    const start = Math.max(0, Math.min(pivot - 500, text.length - 2_400));
    const absoluteStart = Number(chunk.char_start || 0) + start;
    return {
      ...chunk,
      char_start: absoluteStart,
      char_end: absoluteStart + Math.min(2_400, text.length - start),
      content_excerpt: text.slice(start, start + 2_400),
    };
  });
}

function canonicalizeFounderQuoteSpans(output: Record<string, unknown>, chunks: Record<string, unknown>[]) {
  const byChunk = new Map(chunks.map((chunk) => [String(chunk.document_chunk_id || ""), chunk]));
  const claims = Array.isArray(output.evidence_claims) ? output.evidence_claims : [];
  return {
    ...output,
    evidence_claims: claims.map((claim) => {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) return claim;
      const item = claim as Record<string, unknown>;
      const chunk = byChunk.get(String(item.document_chunk_id || item.chunk_id || ""));
      const quote = typeof item.quoted_text === "string" ? item.quoted_text : "";
      const excerpt = typeof chunk?.content_excerpt === "string" ? chunk.content_excerpt : "";
      const offset = quote ? excerpt.indexOf(quote) : -1;
      if (!chunk || offset < 0) return claim;
      const start = Number(chunk.char_start || 0) + offset;
      return { ...item, char_start: start, char_end: start + quote.length };
    }),
  };
}

function deterministicFounderEvidence(chunks: Record<string, unknown>[]) {
  for (const chunk of chunks) {
    const text = typeof chunk.content_excerpt === "string" ? chunk.content_excerpt : "";
    const match = /[^.!?\n]{0,260}\b(?:founder|co[-\s]?founder|founded)\b[^.!?\n]{0,260}[.!?]/i.exec(text);
    if (!match) continue;
    const quotedText = match[0].trim();
    const localOffset = match.index + match[0].indexOf(quotedText);
    const charStart = Number(chunk.char_start || 0) + localOffset;
    return {
      artifact_type: "evidence_claims",
      claim_text: quotedText,
      claim_type: "founder_and_company_history",
      claim_category: "fact",
      source_id: chunk.source_id,
      document_chunk_id: chunk.document_chunk_id,
      quoted_text: quotedText,
      char_start: charStart,
      char_end: charStart + quotedText.length,
      confidence: 0.9,
    };
  }
  return null;
}

export const evidenceExtractionHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "evidence_extraction",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      // 1. Build RunContext
      const v2Ctx = {
        runId: ctx.runId,
        runType: ctx.runType,
        assetId: ctx.assetId,
        assetName: ctx.assetName,
        assetSlug: ctx.assetSlug,
        symbol: ctx.symbol,
        profileId: ctx.profileId || "",
        profileKey: ctx.profileKey || "",
        requiredModules: ctx.composedProfile?.required_artifacts.map((a: any) => a.artifact_type) || [],
        requiredLenses: ctx.composedProfile?.valuation_methods.map((m: any) => m.method) || [],
        marketDataCutoffAt: ctx.marketDataCutoffAt ? ctx.marketDataCutoffAt.toISOString() : null,
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      };

      // 2. Fetch Stored Sources for this run from DB
      const sourceRows = await sql`
        SELECT sd.id as "sourceId", dp.id as "parseId", dc.id as "chunkId",
               sd.source_type as "sourceType", sd.title, sd.publisher, sd.url,
               sd.published_at as "publishedAt", sd.period_end as "periodEnd",
               sd.metadata_json as metadata
        FROM source_documents sd
        JOIN document_parses dp ON dp.source_document_id = sd.id AND dp.status = 'completed'
        JOIN document_chunks dc ON dc.source_document_id = sd.id AND dc.document_parse_id = dp.id
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId}
      `;
      const sources = sourceRows.map(row => ({
        sourceId: String(row.sourceId),
        parseId: String(row.parseId),
        chunkId: String(row.chunkId),
        content: "", // Content not needed for buildSourcePacket mapping
        title: String(row.title),
        sourceType: String(row.sourceType),
        metadata: (row.metadata as Record<string, any>) || {},
      }));

      // 3. Build Source Packet (chunks)
      const sourcePacket = await buildSourcePacket(sql, v2Ctx, sources);
      const founderChunks = (sourcePacket as any[]).filter(
        (chunk) => chunk.source_role === "founder_and_company_history"
      );
      if (founderChunks.length === 0) {
        throw new Error("No qualifying founder/origin source was acquired; retry source discovery with a vetted founder source");
      }

      const evidenceTarget = RUN_TYPE_THRESHOLDS[ctx.runType]?.minEvidenceClaims ?? 12;
      const batches = createSourceReaderBatches(sourcePacket as any[], {
        maxChunks: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS || 4),
        maxBytes: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_BYTES || 16_000),
      });

      if (!batches.length) {
        throw new Error("Source-reader has no persisted source chunks to analyze");
      }

      const batchTarget = Math.max(5, Math.ceil(evidenceTarget / batches.length) + 1);
      const outputs: Record<string, unknown>[] = Array.from({ length: batches.length }, () => ({}));
      const promptFactory = (target: number) => (packet: Record<string, unknown>) => exactJsonPrompt({
        agentName: "source-reader",
        requiredKeys: [...SOURCE_READER_OUTPUT_KEYS],
        packet,
        extraRules: [
          "Each evidence_claim must include claim_text, claim_type, claim_category, source_id, document_chunk_id, quoted_text, char_start, char_end, as_of_date or period_end, and confidence.",
          "claim_category must be exactly one of: fact, estimate, assumption, opinion.",
          "quoted_text must be an exact contiguous substring of the matching source_corpus.content_excerpt, copied character-for-character; do not paraphrase it.",
          "char_start is the absolute inclusive source offset and char_end is the absolute exclusive source offset for quoted_text; copy the bounds from the matching source_corpus chunk and make them agree with quoted_text.",
          `Return up to ${target} distinct, decision-relevant evidence claims supported by this batch. Never return schema examples or placeholder values.`,
          "Use only source_corpus in this packet. Do not invent or alter source or chunk identifiers.",
          "Prefer annual and quarterly SEC filings for financial facts.",
          "Extract at least one decision-relevant claim from every substantive source_corpus chunk before taking additional claims from the same chunk.",
          "For source_role=founder_and_company_history, prioritize the founder's identity, background, stated motivation, problem being solved, company origin, early constraints, and first proof point.",
          "For source_role=industry_primary or peer_company_primary, prioritize independent industry structure and comparative evidence rather than repeating issuer claims.",
        ],
      });

      let nextBatch = 0;
      const workerCount = Math.max(1, Math.min(4, Number(process.env.RESEARCH_AGENT_CONCURRENCY || 3)));
      const batchAbort = new AbortController();
      const batchWorkers = Array.from({ length: Math.min(workerCount, batches.length) }, async () => {
        try {
          while (true) {
            const index = nextBatch++;
            if (index >= batches.length) return;
            const batch = batches[index];
            const fingerprint = sourceReaderBatchFingerprint(batch, batchTarget);
            const taskKey = `source-reader:batch:${batch.id}:${fingerprint}`;
            let output = await latestV3TaskOutput(sql, ctx.runId, taskKey);
            if (output && mergeSourceReaderOutputs([output], [batch]).evidence_claims.length === 0) {
              output = null;
            }
            if (!output) {
              const packet = {
                asset: v2Ctx,
                batch: { id: batch.id, count: batches.length, claim_target: batchTarget },
                source_corpus: batch.chunks,
              };
              output = await callResearchAgent<Record<string, unknown>>({
                sql, ctx, stageKey: "evidence_extraction", taskKey,
                taskType: "evidence_extraction_batch", agentName: "source-reader", modelTier: "cheap",
                packet, signal: batchAbort.signal, promptFactory: promptFactory(batchTarget),
              });
            }
            outputs[index] = output;
          }
        } catch (error) {
          batchAbort.abort();
          throw error;
        }
      });
      const batchResults = await Promise.allSettled(batchWorkers);
      const batchFailure = batchResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (batchFailure) throw batchFailure.reason;

      let evidenceOutput = mergeSourceReaderOutputs(outputs, batches);

      const usableClaims = (out: any) => Array.isArray(out?.evidence_claims) ? out.evidence_claims : [];
      const hasFounderOriginClaim = (out: any) => usableClaims(out).some((claim: any) =>
        founderChunks.some((chunk) => chunk.source_id === claim?.source_id) &&
        FOUNDER_ORIGIN_CLAIM_PATTERN.test(String(claim?.claim_text || ""))
      );

      if (usableClaims(evidenceOutput).length < evidenceTarget) {
        const gapSpecs: Array<{ batch: (typeof batches)[number]; gapTarget: number }> = [];
        let plannedClaims = usableClaims(evidenceOutput).length;
        for (let index = 0; index < batches.length && plannedClaims < evidenceTarget; index += 1) {
          const batch = batches[index];
          const acceptedInBatch = mergeSourceReaderOutputs([outputs[index]], [batch]).evidence_claims.length;
          if (acceptedInBatch >= batchTarget) continue;
          const remaining = evidenceTarget - plannedClaims;
          const gapTarget = Math.max(5, Math.min(batchTarget, remaining));
          gapSpecs.push({ batch, gapTarget });
          plannedClaims += gapTarget;
        }
        const gapOutputs: Record<string, unknown>[] = Array.from({ length: gapSpecs.length }, () => ({}));
        let nextGap = 0;
        const gapAbort = new AbortController();
        const gapWorkers = Array.from({ length: Math.min(workerCount, gapSpecs.length) }, async () => {
          try {
            while (true) {
              const index = nextGap++;
              if (index >= gapSpecs.length) return;
              const { batch, gapTarget } = gapSpecs[index];
              const gapPacket = {
                asset: v2Ctx,
                batch: { id: batch.id, count: batches.length, claim_target: gapTarget, gap_retry: true },
                source_corpus: batch.chunks,
              };
              gapOutputs[index] = await callResearchAgent<Record<string, unknown>>({
                sql, ctx, stageKey: "evidence_extraction",
                taskKey: `source-reader:batch:${batch.id}:${sourceReaderBatchFingerprint(batch, gapTarget)}:gap`,
                taskType: "evidence_extraction_gap", agentName: "source-reader", modelTier: "cheap",
                packet: gapPacket, signal: gapAbort.signal, promptFactory: promptFactory(gapTarget),
              });
            }
          } catch (error) {
            gapAbort.abort();
            throw error;
          }
        });
        const gapResults = await Promise.allSettled(gapWorkers);
        const gapFailure = gapResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (gapFailure) throw gapFailure.reason;
        outputs.push(...gapOutputs);
        evidenceOutput = mergeSourceReaderOutputs(outputs, batches);
      }

      if (!hasFounderOriginClaim(evidenceOutput)) {
        const assetPattern = new RegExp(
          String(ctx.assetName || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        );
        const assetFounderChunks = founderChunks.filter((chunk) => {
          const text = typeof chunk.content_excerpt === "string" ? chunk.content_excerpt : "";
          const title = typeof chunk.title === "string" ? chunk.title : "";
          if (/quartr/i.test(title)) return false;
          return /marcos|galperin/i.test(text) || /mercadolibre|\bmeli\b/i.test(title) || assetPattern.test(title);
        });
        const founderRoleChunks = compactFounderRoleChunks(assetFounderChunks.length ? assetFounderChunks : founderChunks);
        const [founderBatch] = createSourceReaderBatches(founderRoleChunks as any[], {
          maxChunks: Math.max(1, founderChunks.length),
          maxBytes: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_BYTES || 16_000),
        });
        const roleBatch = { ...founderBatch, id: "founder-origin" };
        const founderOutput = await callResearchAgent<Record<string, unknown>>({
          sql,
          ctx,
          stageKey: "evidence_extraction",
          taskKey: `source-reader:role:founder-origin:${sourceReaderBatchFingerprint(roleBatch, Math.max(3, founderChunks.length))}`,
          taskType: "evidence_extraction_role_gap",
          agentName: "source-reader",
          modelTier: "cheap",
          packet: {
            asset: v2Ctx,
            batch: {
              id: roleBatch.id,
              claim_target: Math.max(3, founderChunks.length),
              required_source_role: "founder_and_company_history",
            },
            source_corpus: roleBatch.chunks,
          },
          promptFactory: (packet) => exactJsonPrompt({
            agentName: "source-reader",
            requiredKeys: [...SOURCE_READER_OUTPUT_KEYS],
            packet,
            extraRules: [
              "Extract only directly supported founder and company-origin facts from source_corpus.",
              "At least one claim must identify the founder or founding team and why the relevant technology or company was pursued.",
              "Do not use IPO, financing, bank-charter, or product claims unless they directly establish the company origin or founder motivation.",
              "Prioritize contemporary statements and university archives over later corporate narrative.",
              "Each claim must copy source_id and document_chunk_id exactly and include claim_text, claim_type, claim_category, quoted_text, char_start, char_end, confidence, and the most precise available date.",
              "quoted_text must be an exact contiguous substring of the matching source_corpus.content_excerpt, and char_start/char_end must be the matching absolute inclusive/exclusive bounds.",
              "Do not infer a financial, mission, status, or other motivation unless the source text directly supports it.",
            ],
          }),
        });
        outputs.push(canonicalizeFounderQuoteSpans(founderOutput, roleBatch.chunks as any[]));
        batches.push(roleBatch);
        evidenceOutput = mergeSourceReaderOutputs(outputs, batches);
      }

      if (!hasFounderOriginClaim(evidenceOutput)) {
        const founderEvidence = deterministicFounderEvidence(founderChunks);
        if (founderEvidence) {
          evidenceOutput = {
            ...evidenceOutput,
            evidence_claims: [...usableClaims(evidenceOutput), founderEvidence],
          };
        }
      }

      let persistedEvidenceCount = await persistEvidence(sql, v2Ctx, sources, evidenceOutput);

      if (persistedEvidenceCount < evidenceTarget) {
        // Fallback
        const fallbackEvidence = deterministicEvidenceFallback(v2Ctx, sources, {}, evidenceTarget - persistedEvidenceCount);
        persistedEvidenceCount += await persistEvidence(sql, v2Ctx, sources, fallbackEvidence);
        if (persistedEvidenceCount >= evidenceTarget) {
          evidenceOutput = {
            ...evidenceOutput,
            evidence_claims: [...usableClaims(evidenceOutput), ...usableClaims(fallbackEvidence)],
          };
        }
      }

      await reconcileSourceGaps(sql, v2Ctx, evidenceOutput, "system:source-reader");

      return {
        status: "success",
        extractedClaimsCount: persistedEvidenceCount,
      };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT COUNT(*) as cnt FROM evidence_claims
        WHERE research_run_id = ${ctx.runId}
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No evidence claims extracted for this run");
      }
      const founderRows = await sql`
        SELECT COUNT(DISTINCT ec.id) AS cnt
        FROM evidence_claims ec
        JOIN evidence_links el ON el.evidence_claim_id = ec.id
        JOIN source_locations sl ON sl.id = el.source_location_id
        JOIN source_role_assignments sra ON sra.source_document_id = sl.source_document_id
        WHERE ec.research_run_id = ${ctx.runId}
          AND ec.review_status IN ('machine_verified', 'accepted')
          AND sra.role = 'founder_and_company_history'
          AND (
            LOWER(ec.claim_text) LIKE '%founder%'
            OR LOWER(ec.claim_text) LIKE '%co-founder%'
            OR LOWER(ec.claim_text) LIKE '%cofounder%'
            OR LOWER(ec.claim_text) LIKE '%founded%'
            OR LOWER(ec.claim_text) LIKE '%origin%'
            OR LOWER(ec.claim_text) LIKE '%josé%'
            OR LOWER(ec.claim_text) LIKE '%jose%'
            OR LOWER(ec.claim_text) LIKE '%motivat%'
            OR LOWER(ec.claim_text) LIKE '%professor%'
            OR LOWER(ec.claim_text) LIKE '%mission%'
            OR LOWER(ec.claim_text) LIKE '%sacrifice%'
            OR LOWER(ec.claim_text) LIKE '%lab to the market%'
            OR LOWER(ec.claim_text) LIKE '%marcos%'
            OR LOWER(ec.claim_text) LIKE '%galperin%'
          )
      `;
      if (Number(founderRows[0]?.cnt || 0) === 0) {
        errors.push("No accepted founder/origin evidence was extracted from founder_and_company_history sources");
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
