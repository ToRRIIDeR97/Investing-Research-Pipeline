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
  evaluateEvidenceCoverage,
  extractDeterministicEvidence,
  mergeSourceReaderOutputs,
  planEvidenceBatches,
  SOURCE_READER_OUTPUT_KEYS,
  sourceReaderBatchFingerprint,
} from "../source-reader-batching";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { RUN_TYPE_THRESHOLDS } from "../../workflow/quality-gates";

const FOUNDER_ORIGIN_CLAIM_PATTERN = /founder|co[-\s]?founder|founded|marcos|galperin|motivat|origin|professor|research program|mission|sacrifice|lab to the market/i;

export function buildSourceReaderPrompt(packet: Record<string, unknown>, target: number) {
  return exactJsonPrompt({
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
      "For retrieval_scopes containing member_and_product_growth, extract every disclosed Members and Total Products value with its reporting period and definition.",
      "For retrieval_scopes containing segment_economics, extract each segment's contribution profit, contribution loss, and contribution margin with its reporting period; do not collapse the table into one narrative claim.",
      "For source_role=founder_and_company_history, prioritize the founder's identity, background, stated motivation, problem being solved, company origin, early constraints, and first proof point.",
      "For source_role=industry_primary or peer_company_primary, prioritize independent industry structure and comparative evidence rather than repeating issuer claims.",
    ],
  });
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
      const coverageSlots = ctx.composedProfile?.evidence_coverage_slots || [];
      const existingEvidence = await loadAcceptedEvidencePacket(sql, v2Ctx) as Record<string, unknown>[];
      const existingCoverage = evaluateEvidenceCoverage(coverageSlots, existingEvidence);
      const existingMandatorySatisfied = existingCoverage
        .filter((slot) => slot.priority === "mandatory")
        .every((slot) => slot.status === "satisfied");
      if (existingEvidence.length >= evidenceTarget && existingMandatorySatisfied) {
        return {
          status: "success",
          extractedClaimsCount: existingEvidence.length,
          coverage: existingCoverage,
          effortBudget: { primaryBatches: 0, gapBatches: 0, logicalBatchLimit: 10, underlyingCallLimit: 20, selectedCharacters: 0, selectedBytes: 0 },
          failedBatches: [],
        };
      }
      const planningSlots = existingCoverage.length
        ? coverageSlots.filter((slot) => existingCoverage.some((status) => status.key === slot.key && status.status === "missing"))
        : coverageSlots;
      const batchOptions = {
        maxChunks: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS || 4),
        maxBytes: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_BYTES || 16_000),
      };
      const plan = planningSlots.length
        ? planEvidenceBatches(sourcePacket as any[], planningSlots, {
            ...batchOptions,
            maxBatches: 8,
            maxCharacters: 80_000,
          })
        : {
            batches: createSourceReaderBatches(sourcePacket as any[], batchOptions).slice(0, 8),
            selectedCharacters: (sourcePacket as any[]).slice(0, 32).reduce((sum, chunk) => sum + String(chunk.content_excerpt || "").length, 0),
            selectedBytes: 0,
            coveredSlotKeys: [],
            uncoveredMandatorySlotKeys: [],
          };
      const batches = [...plan.batches];

      if (!batches.length) {
        throw new Error(`Source-reader coverage planner selected no usable chunks${plan.uncoveredMandatorySlotKeys.length ? `; uncovered: ${plan.uncoveredMandatorySlotKeys.join(", ")}` : ""}`);
      }

      const batchTarget = Math.max(5, Math.ceil(evidenceTarget / 8) + 1);
      const outputs: Record<string, unknown>[] = Array.from({ length: batches.length }, () => ({}));
      const deterministicClaims = extractDeterministicEvidence(batches.flatMap((batch) => batch.chunks));
      if (deterministicClaims.length) {
        await persistEvidence(sql, v2Ctx, sources, { evidence_claims: deterministicClaims });
      }
      const afterDeterministic = await loadAcceptedEvidencePacket(sql, v2Ctx) as Record<string, unknown>[];
      const afterCoverage = evaluateEvidenceCoverage(coverageSlots, afterDeterministic);
      const satisfiedByDeterministic = afterDeterministic.length >= evidenceTarget
        && afterCoverage.filter((slot) => slot.priority === 'mandatory').every((slot) => slot.status === 'satisfied');
      const promptFactory = (target: number) => (packet: Record<string, unknown>) => buildSourceReaderPrompt(packet, target);

      let nextBatch = 0;
      const workerCount = Math.max(1, Math.min(3, Number(process.env.RESEARCH_AGENT_CONCURRENCY || 3)));
      const batchFailures: Array<{ batchId: string; error: string }> = [];
      let stopScheduling = satisfiedByDeterministic;
      const batchWorkers = Array.from({ length: Math.min(workerCount, batches.length) }, async () => {
        while (true) {
          if (stopScheduling) return;
          const index = nextBatch++;
          if (index >= batches.length) return;
          const batch = batches[index];
          try {
            const fingerprint = sourceReaderBatchFingerprint(batch, batchTarget);
            let taskKey = `source-reader:batch:${fingerprint}`;
            let output = await latestV3TaskOutput(sql, ctx.runId, taskKey);
            if (output && mergeSourceReaderOutputs([output], [batch]).evidence_claims.length === 0) {
              output = null;
              taskKey += ":citation-retry";
            }
            if (!output) {
              const packet = {
                context_policy: 'focused-v1',
                asset: v2Ctx,
                batch: { id: batch.id, count: batches.length, claim_target: batchTarget, coverage_slots: batch.coverageSlotKeys },
                source_corpus: batch.chunks,
              };
              output = await callResearchAgent<Record<string, unknown>>({
                sql, ctx, stageKey: "evidence_extraction", taskKey,
                taskType: "evidence_extraction_batch", agentName: "source-reader", modelTier: "cheap",
                packet, promptFactory: promptFactory(batchTarget), policy: { maxAttempts: 2, maxRepairAttempts: 0 },
              });
            }
            outputs[index] = output;
            await persistEvidence(sql, v2Ctx, sources, mergeSourceReaderOutputs([output], [batch]));
          } catch (error) {
            const failure = error as { category?: string; responseMetadata?: { error_type?: string } };
            if (failure?.category === 'provider_unavailable' || failure?.responseMetadata?.error_type === 'provider_unavailable'
              || /Stage model-call budget|Evidence logical batch budget/.test(String(error))) stopScheduling = true;
            batchFailures.push({
              batchId: batch.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
      await Promise.all(batchWorkers);

      let evidenceOutput = mergeSourceReaderOutputs(outputs, batches);
      if (deterministicClaims.length) {
        evidenceOutput = {
          ...evidenceOutput,
          evidence_claims: [...deterministicClaims, ...evidenceOutput.evidence_claims],
        };
      }

      const usableClaims = (out: any) => Array.isArray(out?.evidence_claims) ? out.evidence_claims : [];
      const hasFounderOriginClaim = (out: any) => usableClaims(out).some((claim: any) =>
        founderChunks.some((chunk) => chunk.source_id === claim?.source_id) &&
        FOUNDER_ORIGIN_CLAIM_PATTERN.test(String(claim?.claim_text || ""))
      );

      const initialCoverage = evaluateEvidenceCoverage(coverageSlots, [...existingEvidence, ...usableClaims(evidenceOutput)]);
      const missingMandatory = new Set(initialCoverage
        .filter((slot) => slot.priority === "mandatory" && slot.status === "missing")
        .map((slot) => slot.key));
      const failedBatchIds = new Set(batchFailures.map((failure) => failure.batchId));
      const gapBatches = batches
        .filter((batch) => batch.coverageSlotKeys?.some((key) => missingMandatory.has(key)))
        .sort((a, b) => Number(failedBatchIds.has(b.id)) - Number(failedBatchIds.has(a.id)));
      if (usableClaims(evidenceOutput).length < evidenceTarget) {
        for (const batch of batches) {
          if (!gapBatches.includes(batch)) gapBatches.push(batch);
        }
      }
      const selectedGapBatches = stopScheduling ? [] : gapBatches.slice(0, 2);
      const gapResults = await Promise.allSettled(selectedGapBatches.map(async (batch) => {
        const gapTarget = Math.max(5, Math.min(batchTarget, evidenceTarget - usableClaims(evidenceOutput).length || batchTarget));
        const output = await callResearchAgent<Record<string, unknown>>({
          sql, ctx, stageKey: "evidence_extraction",
          taskKey: `source-reader:gap:${sourceReaderBatchFingerprint(batch, gapTarget)}`,
          taskType: "evidence_extraction_gap", agentName: "source-reader", modelTier: "cheap",
          packet: {
            context_policy: 'focused-v1',
            asset: v2Ctx,
            batch: { id: batch.id, count: batches.length, claim_target: gapTarget, gap_retry: true, coverage_slots: batch.coverageSlotKeys },
            source_corpus: batch.chunks,
          },
          promptFactory: promptFactory(gapTarget), policy: { maxAttempts: 2, maxRepairAttempts: 0 },
        });
        await persistEvidence(sql, v2Ctx, sources, mergeSourceReaderOutputs([output], [batch]));
        return output;
      }));
      for (const result of gapResults) {
        if (result.status === "fulfilled") outputs.push(result.value);
        else batchFailures.push({ batchId: "gap", error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
      evidenceOutput = mergeSourceReaderOutputs(outputs, batches);
      if (deterministicClaims.length) {
        evidenceOutput.evidence_claims.unshift(...deterministicClaims);
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

      await persistEvidence(sql, v2Ctx, sources, evidenceOutput);
      let countRows = await sql`SELECT COUNT(*) AS count FROM evidence_claims WHERE research_run_id = ${ctx.runId}`;
      let persistedEvidenceCount = Number(countRows[0]?.count || 0);

      if (persistedEvidenceCount < evidenceTarget) {
        const fallbackEvidence = deterministicEvidenceFallback(v2Ctx, sources, {}, evidenceTarget - persistedEvidenceCount);
        await persistEvidence(sql, v2Ctx, sources, fallbackEvidence);
        evidenceOutput = {
          ...evidenceOutput,
          evidence_claims: [...usableClaims(evidenceOutput), ...usableClaims(fallbackEvidence)],
        };
        countRows = await sql`SELECT COUNT(*) AS count FROM evidence_claims WHERE research_run_id = ${ctx.runId}`;
        persistedEvidenceCount = Number(countRows[0]?.count || 0);
      }

      const acceptedEvidence = await loadAcceptedEvidencePacket(sql, v2Ctx) as Record<string, unknown>[];
      const coverage = evaluateEvidenceCoverage(coverageSlots, acceptedEvidence);
      evidenceOutput.source_gaps = coverage
        .filter((slot) => slot.status === "missing")
        .map((slot) => ({
          gap_key: slot.key,
          priority: slot.priority,
          description: `Evidence coverage slot ${slot.key} is missing`,
          accepted_claim_count: slot.acceptedClaimCount,
          period_count: slot.periodCount,
        }));
      await reconcileSourceGaps(sql, v2Ctx, evidenceOutput, "system:source-reader");
      const [effort] = await sql`SELECT
        (SELECT COUNT(DISTINCT regexp_replace(task_key, ':revision-[0-9]+$', '')) FROM research_tasks
          WHERE research_run_id = ${ctx.runId} AND stage_id IN (SELECT id FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = 'evidence_extraction')) AS logical_batches,
        (SELECT COUNT(*) FROM model_budget_reservations WHERE research_run_id = ${ctx.runId}
          AND stage_id IN (SELECT id FROM research_stages WHERE research_run_id = ${ctx.runId} AND stage_key = 'evidence_extraction')) AS reserved_attempts`;

      return {
        status: "success",
        extractedClaimsCount: persistedEvidenceCount,
        coverage,
        effortBudget: {
          logicalBatchesUsed: Number(effort.logical_batches),
          attemptsReserved: Number(effort.reserved_attempts),
          primaryBatches: batches.length,
          gapBatches: selectedGapBatches.length,
          logicalBatchLimit: 10,
          underlyingCallLimit: 20,
          selectedCharacters: plan.selectedCharacters,
          selectedBytes: plan.selectedBytes,
        },
        failedBatches: batchFailures,
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
      const missingMandatory = Array.isArray(output?.coverage)
        ? output.coverage.filter((slot: any) => slot?.priority === "mandatory" && slot?.status !== "satisfied")
        : [];
      if (missingMandatory.length) {
        errors.push(`Missing mandatory evidence coverage: ${missingMandatory.map((slot: any) => slot.key).join(", ")}`);
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
