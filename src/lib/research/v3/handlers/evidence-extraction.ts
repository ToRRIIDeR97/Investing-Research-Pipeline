import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { callV3Agent, v3ExactJsonPrompt } from "../../v3-context";
import {
  buildSourcePacket,
  persistEvidence,
  deterministicEvidenceFallback,
  loadAcceptedEvidencePacket,
  reconcileSourceGaps,
} from "../../system-pipeline";
import { createSourceReaderBatches, mergeSourceReaderOutputs } from "../../source-reader-batching";
import postgres from "postgres";

const SOURCE_READER_OUTPUT_KEYS = [
  "evidence_claims",
  "contradictions",
  "source_gaps",
  "low_confidence_items",
  "rejected_candidates",
];

export const evidenceExtractionHandler: V3StageHandler<unknown> = {
  stageKey: "evidence_extraction",
  async execute(ctx: V3RunContext): Promise<unknown> {
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
        pipelineVersion: 3,
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
      const promptFactory = (target: number) => (packet: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "source-reader",
        requiredKeys: [...SOURCE_READER_OUTPUT_KEYS],
        packet,
        extraRules: [
          "Each evidence_claim must include claim_text, claim_type, claim_category, source_id and document_chunk_id copied exactly from source_corpus, plus char_start/char_end within the original document when available, as_of_date or period_end, and confidence.",
          `Return up to ${target} distinct, decision-relevant evidence claims supported by this batch. Never return schema examples or placeholder values.`,
          "Use only source_corpus in this packet. Do not invent or alter source or chunk identifiers.",
          "Prefer annual and quarterly SEC filings for financial facts.",
        ],
      });

      for (const batch of batches) {
        const taskKey = `source-reader:batch:${batch.id}`;
        let output = await sql`
          SELECT output_json FROM research_tasks
          WHERE research_run_id = ${ctx.runId} AND task_key = ${taskKey} AND status = 'completed'
        `.then(rows => rows[0]?.output_json as Record<string, any>);

        if (!output) {
          const packet = {
            asset: v2Ctx,
            batch: { id: batch.id, count: batches.length, claim_target: batchTarget },
            source_corpus: batch.chunks,
          };
          output = await callV3Agent<Record<string, unknown>>({
            sql, ctx, stageKey: "evidence_extraction", taskKey,
            taskType: "evidence_extraction_batch", agentName: "source-reader", modelTier: "cheap",
            packet, promptFactory: promptFactory(batchTarget),
          });
        }
        outputs.push(output);
      }

      let evidenceOutput = mergeSourceReaderOutputs(outputs, batches);

      const usableClaims = (out: any) => Array.isArray(out?.evidence_claims) ? out.evidence_claims : [];

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
          const gapOutput = await callV3Agent<Record<string, unknown>>({
            sql, ctx, stageKey: "evidence_extraction", taskKey: `source-reader:batch:${batch.id}:gap`,
            taskType: "evidence_extraction_gap", agentName: "source-reader", modelTier: "cheap",
            packet: gapPacket, promptFactory: promptFactory(gapTarget),
          });
          outputs.push(gapOutput);
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
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
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
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
