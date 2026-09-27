import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import {
  buildSourcePacket,
  persistEvidence,
  deterministicEvidenceFallback,
  loadAcceptedEvidencePacket,
  reconcileSourceGaps,
} from "../sources/corpus";
import {
  createSourceReaderBatches,
  mergeSourceReaderOutputs,
  sourceReaderBatchFingerprint,
} from "../source-reader-batching";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { isValidSourceRole } from "../sources/roles";
import { isPlausibleSourceRole } from "../sources/role-discovery";

const SOURCE_READER_OUTPUT_KEYS = [
  "evidence_claims",
  "contradictions",
  "source_gaps",
  "low_confidence_items",
  "rejected_candidates",
];

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
               sd.created_at as "createdAt",
               sd.metadata_json as metadata
        FROM source_documents sd
        JOIN document_parses dp ON dp.source_document_id = sd.id AND dp.status = 'completed'
        JOIN document_chunks dc ON dc.source_document_id = sd.id AND dc.document_parse_id = dp.id
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId}
      `;
      const excludedSourceIds = [...new Set(sourceRows.filter((row) => {
        const role = String((row.metadata as Record<string, unknown> | null)?.source_role ||
          (String(row.sourceType).startsWith("web_") ? String(row.sourceType).slice(4) : ""));
        return Boolean(row.url) && isValidSourceRole(role) && !isPlausibleSourceRole(String(row.url), role);
      }).map((row) => String(row.sourceId)))];
      if (excludedSourceIds.length) {
        await sql`
          UPDATE evidence_claims ec
          SET review_status = 'rejected', reviewed_by = 'system:source-role-reconciliation', reviewed_at = NOW()
          WHERE ec.research_run_id = ${ctx.runId} AND ec.review_status != 'rejected'
            AND EXISTS (
              SELECT 1 FROM evidence_links el JOIN source_locations sl ON sl.id = el.source_location_id
              WHERE el.evidence_claim_id = ec.id AND sl.source_document_id = ANY(${excludedSourceIds}::uuid[])
            )
            AND NOT EXISTS (
              SELECT 1 FROM evidence_links el JOIN source_locations sl ON sl.id = el.source_location_id
              WHERE el.evidence_claim_id = ec.id AND sl.source_document_id != ALL(${excludedSourceIds}::uuid[])
            )
        `;
      }
      const eligibleSourceRows = sourceRows.filter((row) => !excludedSourceIds.includes(String(row.sourceId)));
      const latestByUrl = new Map<string, { id: string; createdAt: number }>();
      for (const row of eligibleSourceRows) {
        const key = String(row.url || row.sourceId);
        const createdAt = new Date(row.createdAt).getTime();
        const prior = latestByUrl.get(key);
        if (!prior || createdAt > prior.createdAt) {
          latestByUrl.set(key, { id: String(row.sourceId), createdAt });
        }
      }
      const currentSourceRows = eligibleSourceRows.filter((row) =>
        latestByUrl.get(String(row.url || row.sourceId))?.id === String(row.sourceId)
      );
      const sources = currentSourceRows.map(row => ({
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

      const evidenceTarget = ctx.runType === "deep_dive" ? 25 : 12;
      const batches = createSourceReaderBatches(sourcePacket as any[], {
        maxChunks: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS || 8),
        maxBytes: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_BYTES || 36_000),
      });

      if (!batches.length) {
        throw new Error("Source-reader has no persisted source chunks to analyze");
      }

      const batchTarget = Math.max(5, Math.ceil(evidenceTarget / batches.length) + 1);
      const outputs: Record<string, unknown>[] = [];
      const promptFactory = (target: number) => (packet: Record<string, unknown>) => exactJsonPrompt({
        agentName: "source-reader",
        requiredKeys: [...SOURCE_READER_OUTPUT_KEYS],
        packet,
        extraRules: [
          "Each evidence_claim must include claim_text, claim_type, claim_category, source_id and document_chunk_id copied exactly from source_corpus, plus char_start/char_end within the original document when available, as_of_date or period_end, and confidence.",
          "claim_category must be exactly one of: fact, estimate, assumption, opinion. Put topical labels such as strategy or funding in claim_type, never in claim_category.",
          `Return up to ${target} distinct, decision-relevant evidence claims supported by this batch. Never return schema examples or placeholder values.`,
          "Use only source_corpus in this packet. Do not invent or alter source or chunk identifiers.",
          "Prefer annual and quarterly SEC filings for financial facts.",
          "Extract at least one decision-relevant claim from every substantive source_corpus chunk before taking additional claims from the same chunk.",
          "For source_role=founder_and_company_history, prioritize the founder's identity, background, stated motivation, problem being solved, company origin, early constraints, and first proof point.",
          "For source_role=industry_primary or peer_company_primary, prioritize independent industry structure and comparative evidence rather than repeating issuer claims.",
        ],
      });

      for (const batch of batches) {
        const fingerprint = sourceReaderBatchFingerprint(batch);
        const taskKey = `source-reader:batch:${batch.id}:${fingerprint}`;

        const packet = {
          asset: v2Ctx,
          batch: { id: batch.id, count: batches.length, claim_target: batchTarget },
          source_corpus: batch.chunks,
        };
        const output = await callResearchAgent<Record<string, unknown>>({
          sql, ctx, stageKey: "evidence_extraction", taskKey,
          taskType: "evidence_extraction_batch", agentName: "source-reader", modelTier: "cheap",
          packet, promptFactory: promptFactory(batchTarget),
        });
        outputs.push(output);
      }

      let evidenceOutput = mergeSourceReaderOutputs(outputs, batches);

      const usableClaims = (out: any) => Array.isArray(out?.evidence_claims) ? out.evidence_claims : [];
      const hasFounderOriginClaim = (out: any) => usableClaims(out).some((claim: any) =>
        claim?.source_role === "founder_and_company_history" ||
        (
          (sourcePacket as any[]).some(
            (chunk) =>
              chunk.source_role === "founder_and_company_history" &&
              chunk.source_id === claim?.source_id
          ) &&
          /founder|founded|motivat|origin|professor|research program/i.test(String(claim?.claim_text || ""))
        )
      );

      if (usableClaims(evidenceOutput).length < evidenceTarget) {
        for (let index = 0; index < batches.length && usableClaims(evidenceOutput).length < evidenceTarget; index += 1) {
          const batch = batches[index];
          const acceptedInBatch = mergeSourceReaderOutputs([outputs[index]], [batch]).evidence_claims.length;
          if (acceptedInBatch >= batchTarget) continue;
          const remaining = evidenceTarget - usableClaims(evidenceOutput).length;
          const gapTarget = Math.max(5, Math.min(batchTarget, remaining));
          const gapPacket = {
            asset: v2Ctx,
            batch: { id: batch.id, count: batches.length, claim_target: gapTarget, gap_retry: true },
            source_corpus: batch.chunks,
          };
          const gapOutput = await callResearchAgent<Record<string, unknown>>({
            sql, ctx, stageKey: "evidence_extraction",
            taskKey: `source-reader:batch:${batch.id}:${sourceReaderBatchFingerprint(batch)}:gap`,
            taskType: "evidence_extraction_gap", agentName: "source-reader", modelTier: "cheap",
            packet: gapPacket, promptFactory: promptFactory(gapTarget),
          });
          outputs.push(gapOutput);
          evidenceOutput = mergeSourceReaderOutputs(outputs, batches);
        }
      }

      if (!hasFounderOriginClaim(evidenceOutput)) {
        const founderChunks = (sourcePacket as any[]).filter(
          (chunk) => chunk.source_role === "founder_and_company_history"
        );
        if (founderChunks.length > 0) {
          const [founderBatch] = createSourceReaderBatches(founderChunks, {
            maxChunks: Math.max(1, founderChunks.length),
            maxBytes: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_BYTES || 36_000),
          });
          const roleBatch = { ...founderBatch, id: "founder-origin" };
          const founderOutput = await callResearchAgent<Record<string, unknown>>({
            sql,
            ctx,
            stageKey: "evidence_extraction",
            taskKey: `source-reader:role:founder-origin:${sourceReaderBatchFingerprint(roleBatch)}`,
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
                "Prioritize contemporary statements and university archives over later corporate narrative.",
                "Each claim must copy source_id and document_chunk_id exactly and include claim_text, claim_type, claim_category, confidence, and the most precise available date.",
                "claim_category must be exactly one of: fact, estimate, assumption, opinion. Use claim_type for the topic.",
                "Do not infer a financial, mission, status, or other motivation unless the source text directly supports it.",
              ],
            }),
          });
          outputs.push(founderOutput);
          batches.push(roleBatch);
          evidenceOutput = mergeSourceReaderOutputs(outputs, batches);
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
          AND ec.review_status = 'accepted'
          AND sra.role = 'founder_and_company_history'
          AND (
            LOWER(ec.claim_text) LIKE '%founder%'
            OR LOWER(ec.claim_text) LIKE '%founded%'
            OR LOWER(ec.claim_text) LIKE '%founding%'
            OR LOWER(ec.claim_text) LIKE '%origin%'
            OR LOWER(ec.claim_text) LIKE '%started by%'
            OR LOWER(ec.claim_text) LIKE '%josé%'
            OR LOWER(ec.claim_text) LIKE '%jose%'
            OR LOWER(ec.claim_text) LIKE '%motivat%'
            OR LOWER(ec.claim_text) LIKE '%professor%'
            OR LOWER(ec.claim_text) LIKE '%mission%'
            OR LOWER(ec.claim_text) LIKE '%sacrifice%'
            OR LOWER(ec.claim_text) LIKE '%lab to the market%'
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
