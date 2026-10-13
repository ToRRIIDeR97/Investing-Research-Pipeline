import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import {
  buildSourcePacket,
  persistEvidence,
  deterministicEvidenceFallback,
  loadAcceptedEvidencePacket,
  reconcileSourceGaps,
  SOURCE_META_CLAIM,
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
import { v2RunContext } from "../sources/role-coverage";
import { FOUNDER_NEED_KEYS, FOUNDER_ORIGIN_NEED, headlineKpis, retrievePassages } from "../memory";
import { mapWithConcurrency } from "../pipeline-helpers";
import { getStageSourceRequests, queueSourceRequests, SourceRequestsPending } from "../sources/source-requests";
import { MAX_STAGE_SOURCE_REQUEST_ROUNDS } from "../team-plan";

const SOURCE_READER_OUTPUT_KEYS = [
  "evidence_claims",
  "contradictions",
  "source_gaps",
  "low_confidence_items",
  "rejected_candidates",
];

const NO_META_CLAIMS = "Every evidence claim states a fact about the company or its environment. Never write a claim about the supplied chunk or passage itself, or about information it lacks; record missing information in source_gaps instead.";

/** What differs between batches; the asset context before them is shared and cached. */
const BATCH_KEYS = ["batch", "source_corpus"];

/** Contradictions become `contradicts` edges between the two named claims once both are stored. */
const CONTRADICTION_SHAPE = "Each contradictions entry is {claim_texts: [two claim_text values copied exactly from your evidence_claims], description, confidence from 0 to 1}. List only conflicts between claims you return.";

/**
 * A founder claim must affirm something: claims that only report the founder as missing, or that
 * describe the supplied excerpt, do not count.
 */
export const FOUNDER_TERMS = /founder|founded|founding|co-?founded|started by|origin|motivat|professor|mission|lab to the market/i;
export const ABSENCE_STATEMENT = /\b(?:does|do|did)\s+not\b|\bdoesn['’]t\b|\bcannot\b|\bnot\s+(?:name|named|identif\w*|state[ds]?|disclos\w*|mention\w*|provide[ds]?|support\w*|present|available|known)\b|\bno\s+(?:founder|founding|information|evidence|mention|narrative)\b|\b(?:is|are|remains?)\s+(?:unknown|unclear|absent|missing)\b/i;

/**
 * How many claims evidence extraction aims for. `target` grows with the number of documents
 * (base + per source, capped); `floor` is the minimum the deterministic fallback tops up to.
 */
export function evidenceTargets(runType: string, sourceCount: number, env: Record<string, string | undefined> = process.env) {
  const deep = runType === "deep_dive" || runType === "full_initiation_report";
  const base = Number(env.RESEARCH_EVIDENCE_TARGET_BASE || (deep ? 40 : 20));
  const perSource = Number(env.RESEARCH_EVIDENCE_TARGET_PER_SOURCE || 3);
  const max = Number(env.RESEARCH_EVIDENCE_TARGET_MAX || 160);
  const floor = deep ? 25 : 12;
  return { target: Math.max(floor, Math.min(max, Math.round(base + perSource * sourceCount))), floor };
}

const sourceReaderPrompt = (target: number, kpis: string[]) => (packet: Record<string, unknown>) => exactJsonPrompt({
  agentName: "source-reader",
  requiredKeys: [...SOURCE_READER_OUTPUT_KEYS],
  packet,
  extraRules: [
    "Each evidence_claim must include claim_text, claim_type, claim_category, source_id and document_chunk_id copied exactly from source_corpus, plus char_start/char_end within the original document when available, as_of_date or period_end, and confidence.",
    "Give each evidence_claim a quoted_text: the supporting sentence or table row copied exactly from content_excerpt, at most 300 characters.",
    "claim_category must be exactly one of: fact, estimate, assumption, opinion. Put topical labels such as strategy or funding in claim_type, never in claim_category.",
    `Headline operating KPIs for this asset: ${kpis.join("; ")}. When source_corpus reports one, extract each reported value as its own fact claim with claim_type operating_kpi, stating the figure, unit and period, before other claims from that chunk.`,
    `Return up to ${target} distinct, decision-relevant evidence claims supported by this batch. Never return schema examples or placeholder values.`,
    "Use only source_corpus in this packet. Do not invent or alter source or chunk identifiers.",
    NO_META_CLAIMS,
    CONTRADICTION_SHAPE,
    "Prefer annual and quarterly SEC filings for financial facts.",
    "Extract at least one decision-relevant claim from every substantive source_corpus chunk before taking additional claims from the same chunk.",
    "For source_role=founder_and_company_history, prioritize the founder's identity, background, stated motivation, problem being solved, company origin, early constraints, and first proof point.",
    "For source_role=industry_primary or peer_company_primary, prioritize independent industry structure and comparative evidence rather than repeating issuer claims.",
  ],
});

/**
 * No passage answers either founder need: ask the collector for founder history before any source-reader
 * call, one search per round, and wait while a round is queued. Once the rounds are used up, fail with the
 * founder need's gap instead of spending every batch on a run that cannot pass the founder check.
 */
async function requestFounderSources(sql: ReturnType<typeof postgres>, ctx: ResearchRunContext, sourceIds: string[]): Promise<never> {
  const stageKey = "evidence_extraction";
  const rounds = (await getStageSourceRequests(sql, ctx.runId, stageKey))?.rounds || [];
  if (rounds.some(round => round.state === "queued")) throw new SourceRequestsPending(stageKey);
  if (rounds.length < MAX_STAGE_SOURCE_REQUEST_ROUNDS) {
    const round = rounds.length + 1;
    await queueSourceRequests(sql, ctx, stageKey, "data", `founder-origin:round-${round}`, [{
      source_role: "founder_and_company_history",
      query: round === 1 ? `${ctx.assetName} founders and founding history` : `${ctx.assetName} (${ctx.symbol}) company origin: who founded it and why`,
      reason: "No passage in the run's documents states who founded the company or why.",
    }]);
    throw new SourceRequestsPending(stageKey);
  }
  const { gaps } = await retrievePassages(sql, { runId: ctx.runId, need: { ...FOUNDER_ORIGIN_NEED, sourceIds } });
  const gap = gaps[0] || { reason: "no_matching_passages", detail: "No founder-history passage matched." };
  throw new Error(`Evidence extraction has no ${FOUNDER_ORIGIN_NEED.key} passage after ${rounds.length} collector rounds (${gap.reason}): ${gap.detail}`);
}

/**
 * Read only documents fetched for a specialist's request. The completed extraction stage is not
 * replayed, so earlier evidence and its downstream analyses stay intact.
 */
export async function extractEvidenceForSources(sql: ReturnType<typeof postgres>, ctx: ResearchRunContext, sourceIds: string[]) {
  if (!sourceIds.length) return 0;
  const v2Ctx = v2RunContext(ctx);
  const rows = await sql`
    SELECT sd.id as "sourceId", dp.id as "parseId", dc.id as "chunkId",
           sd.source_type as "sourceType", sd.title, sd.metadata_json as metadata
    FROM source_documents sd
    JOIN document_parses dp ON dp.source_document_id = sd.id AND dp.status = 'completed'
    JOIN document_chunks dc ON dc.source_document_id = sd.id AND dc.document_parse_id = dp.id
    WHERE sd.id = ANY(${sourceIds}::uuid[])
  `;
  const sources = rows.map(row => ({ sourceId: String(row.sourceId), parseId: String(row.parseId), chunkId: String(row.chunkId),
    content: "", title: String(row.title), sourceType: String(row.sourceType), metadata: (row.metadata as Record<string, any>) || {} }));
  const kpis = headlineKpis(ctx.archetypeKeys || []);
  const sourcePacket = await buildSourcePacket(sql, v2Ctx, sources, { kpis });
  const batches = createSourceReaderBatches(sourcePacket as any[], {
    maxChunks: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS || 8),
    maxBytes: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_BYTES || 36_000),
  });
  // Batches are independent; outputs stay index-aligned with batches for the merge.
  const outputs = await mapWithConcurrency(batches, batch => callResearchAgent<Record<string, unknown>>({
    sql, ctx, stageKey: "evidence_extraction",
    taskKey: `source-reader:requested:${batch.id}:${sourceReaderBatchFingerprint(batch)}`,
    taskType: "evidence_extraction_batch", agentName: "source-reader", modelTier: "cheap",
    packet: { asset: v2Ctx, batch: { id: batch.id, count: batches.length, claim_target: 5 }, source_corpus: batch.chunks },
    promptFactory: sourceReaderPrompt(5, kpis), perCallKeys: BATCH_KEYS,
  }));
  return persistEvidence(sql, v2Ctx, sources, mergeSourceReaderOutputs(outputs, batches));
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
      // One row per document; its passages come from the research memory.
      const sourceRows = await sql`
        SELECT DISTINCT ON (sd.id) sd.id as "sourceId", dp.id as "parseId", dc.id as "chunkId",
               sd.source_type as "sourceType", sd.title, sd.publisher, sd.url,
               sd.published_at as "publishedAt", sd.period_end as "periodEnd",
               sd.created_at as "createdAt",
               sd.metadata_json as metadata
        FROM source_documents sd
        JOIN document_parses dp ON dp.source_document_id = sd.id AND dp.status = 'completed'
        JOIN document_chunks dc ON dc.source_document_id = sd.id AND dc.document_parse_id = dp.id
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId}
        ORDER BY sd.id, dc.chunk_index
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
      const kpis = headlineKpis(ctx.archetypeKeys || []);
      const sourcePacket = await buildSourcePacket(sql, v2Ctx, sources, { kpis });
      if (!(sourcePacket as any[]).some((chunk) => FOUNDER_NEED_KEYS.includes(chunk.need))) {
        await requestFounderSources(sql, ctx, sources.map((source) => source.sourceId));
      }

      const { target: evidenceTarget, floor: evidenceFloor } = evidenceTargets(ctx.runType, sources.length);
      const batches = createSourceReaderBatches(sourcePacket as any[], {
        maxChunks: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_CHUNKS || 8),
        maxBytes: Number(process.env.RESEARCH_SOURCE_READER_BATCH_MAX_BYTES || 36_000),
      });

      if (!batches.length) {
        throw new Error("Source-reader has no persisted source chunks to analyze");
      }

      const batchTarget = Math.max(5, Math.ceil(evidenceTarget / batches.length) + 1);
      const promptFactory = (target: number) => sourceReaderPrompt(target, kpis);

      // Batches are independent; outputs stay index-aligned with batches for the merge.
      const outputs = await mapWithConcurrency(batches, batch => {
        const fingerprint = sourceReaderBatchFingerprint(batch);
        const taskKey = `source-reader:batch:${batch.id}:${fingerprint}`;

        const packet = {
          asset: v2Ctx,
          batch: { id: batch.id, count: batches.length, claim_target: batchTarget },
          source_corpus: batch.chunks,
        };
        return callResearchAgent<Record<string, unknown>>({
          sql, ctx, stageKey: "evidence_extraction", taskKey,
          taskType: "evidence_extraction_batch", agentName: "source-reader", modelTier: "cheap",
          packet, promptFactory: promptFactory(batchTarget), perCallKeys: BATCH_KEYS,
        });
      });

      let evidenceOutput = mergeSourceReaderOutputs(outputs, batches);

      const usableClaims = (out: any) => Array.isArray(out?.evidence_claims) ? out.evidence_claims : [];
      // The founder pass is skipped only when a claim already affirms the founder or origin.
      const hasFounderOriginClaim = (out: any) => usableClaims(out).some((claim: any) => {
        const text = String(claim?.claim_text || "");
        return FOUNDER_TERMS.test(text) && !ABSENCE_STATEMENT.test(text) && !SOURCE_META_CLAIM.test(text);
      });

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
        // Only passages that answered a founder need (founder-history documents first, then filings and
        // investor material); never a founder document's opening pages.
        const founderChunks = FOUNDER_NEED_KEYS.flatMap((key) => (sourcePacket as any[]).filter((chunk) => chunk.need === key));
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
                NO_META_CLAIMS,
                CONTRADICTION_SHAPE,
              ],
            }),
          });
          // First, so the evidence cap in persistEvidence never drops the claims the founder check needs.
          outputs.unshift(founderOutput);
          batches.unshift(roleBatch);
          evidenceOutput = mergeSourceReaderOutputs(outputs, batches);
        }
      }

      // The cap leaves room for the founder pass, which is merged first.
      let persistedEvidenceCount = await persistEvidence(sql, v2Ctx, sources, evidenceOutput, evidenceTarget + 10);

      if (persistedEvidenceCount < evidenceFloor) {
        // Fallback: inventory claims top up to the floor only, never to the scaled target.
        const fallbackEvidence = deterministicEvidenceFallback(v2Ctx, sources, {}, evidenceFloor - persistedEvidenceCount);
        persistedEvidenceCount += await persistEvidence(sql, v2Ctx, sources, fallbackEvidence);
        if (persistedEvidenceCount >= evidenceFloor) {
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
      // System inventory and metric claims name document types, not founders.
      const founderClaims = await sql`
        SELECT ec.claim_text
        FROM evidence_claims ec
        WHERE ec.research_run_id = ${ctx.runId}
          AND ec.review_status = 'accepted'
          AND ec.claim_type NOT IN ('source_inventory_fact', 'deterministic_metric_observation')
      `;
      const founderRows = [{ cnt: founderClaims.filter((row) => {
        const text = String(row.claim_text || "");
        return FOUNDER_TERMS.test(text) && !ABSENCE_STATEMENT.test(text) && !SOURCE_META_CLAIM.test(text);
      }).length }];
      if (Number(founderRows[0]?.cnt || 0) === 0) {
        errors.push("No accepted claim affirms the founder or company origin (absence statements and claims about the supplied excerpt do not count)");
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
