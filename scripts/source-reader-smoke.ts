import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { redactHarnessText } from "../src/lib/agent-harness/errors";
import { loadResearchEnvFiles } from "../src/lib/config/research-env";
import { buildSourceReaderPrompt } from "../src/lib/research/handlers/evidence-extraction";
import { callResearchAgent, loadRunContext } from "../src/lib/research/run-context";
import {
  createSourceReaderBatches,
  mergeSourceReaderOutputs,
  sourceReaderBatchFingerprint,
  type SourceReaderBatch,
  type SourceReaderChunk,
} from "../src/lib/research/source-reader-batching";
import { buildSourcePacket, type RunContext, type StoredSource } from "../src/lib/research/system-pipeline";
import { CURRENT_PIPELINE_VERSION } from "../src/lib/research/version";

const CANARY_SOURCE_PATH = "storage/sources/621d87c594d6ed57cdec9220a2aadd05b069e97bd438f2fa05fb69632e221336.html";
const EXPECTED_CLAIMS = [
  { claimType: "members", periodEnd: "2026-03-31", value: "14,706,040" },
  { claimType: "members", periodEnd: "2025-03-31", value: "10,915,811" },
  { claimType: "total_products", periodEnd: "2026-03-31", value: "22,159,146" },
  { claimType: "total_products", periodEnd: "2025-03-31", value: "15,915,425" },
] as const;

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function matchingClaim(claims: Record<string, unknown>[], expected: typeof EXPECTED_CLAIMS[number]) {
  const typePattern = expected.claimType === "members" ? /member/i : /product/i;
  return claims.find((claim) =>
    typePattern.test(`${String(claim.claim_type || "")} ${String(claim.claim_text || "")}`) &&
    String(claim.period_end || claim.as_of_date || "").startsWith(expected.periodEnd) &&
    `${String(claim.claim_text || "")} ${String(claim.quoted_text || "")}`.includes(expected.value)
  );
}

function validateCanaryOutput(value: unknown, batch: SourceReaderBatch) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const output = value as Record<string, unknown>;
  const claims = records(output.evidence_claims);
  const errors: Array<{ path: string; message: string }> = [];

  for (const [index, claim] of claims.entries()) {
    const result = mergeSourceReaderOutputs([{ evidence_claims: [claim] }], [batch]);
    const rejected = result.rejected_invalid_claims[0] || result.rejected_invalid_citations[0];
    if (rejected) {
      errors.push({
        path: `evidence_claims[${index}]`,
        message: `Canary validation failed: ${String(rejected.rejection_reason)}`,
      });
    } else if (result.evidence_claims[0]?.citation_repaired === true) {
      errors.push({
        path: `evidence_claims[${index}].char_start`,
        message: "Absolute offsets did not exactly locate quoted_text",
      });
    }
  }

  const accepted = mergeSourceReaderOutputs([output], [batch]).evidence_claims;
  for (const expected of EXPECTED_CLAIMS) {
    if (!matchingClaim(accepted, expected)) {
      errors.push({
        path: `canary_expectations.${expected.claimType}.${expected.periodEnd}`,
        message: `Missing expected value ${expected.value}`,
      });
    }
  }
  return errors;
}

async function auditSummary(sql: ReturnType<typeof postgres>, runId: string) {
  const [task] = await sql`
    SELECT id, status, validation_status, cost_usd
    FROM research_tasks
    WHERE research_run_id = ${runId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const [call] = await sql`
    SELECT id, status, model_provider, model_name, input_tokens, output_tokens,
           cost_usd, cost_source, latency_ms,
           response_metadata_json->>'request_id' AS request_id,
           response_metadata_json->'validation_errors' AS validation_errors
    FROM model_call_logs
    WHERE research_run_id = ${runId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const [staging] = await sql`
    SELECT id,
           payload_json->>'raw_response_excerpt' IS NOT NULL AS raw_response_persisted,
           payload_json->'validation_errors' AS validation_errors,
           jsonb_array_length(COALESCE(payload_json->'attempts', '[]'::jsonb)) AS attempt_count
    FROM agent_output_staging
    WHERE research_run_id = ${runId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const [run] = await sql`SELECT status, actual_cost_usd FROM research_runs WHERE id = ${runId}`;
  return { run, task: task || null, modelCall: call || null, rejectedOutput: staging || null };
}

async function main() {
  loadResearchEnvFiles();
  if (process.env.RUN_SOURCE_READER_SMOKE !== "1") {
    throw new Error("Set RUN_SOURCE_READER_SMOKE=1 to authorize one paid source-reader canary request");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the durable source-reader canary");
  if (!process.env.RESEARCH_MODEL_PROVIDER || process.env.RESEARCH_MODEL_PROVIDER === "mock") {
    throw new Error("Configure a non-mock RESEARCH_MODEL_PROVIDER for the paid source-reader canary");
  }
  process.env.RESEARCH_PROVIDER_CONCURRENCY = "1";

  const sql = postgres(process.env.DATABASE_URL);
  let runId: string | undefined;
  try {
    const [source] = await sql`
      SELECT sd.id, sd.asset_id, sd.source_type, sd.title, sd.url, sd.metadata_json,
             a.primary_profile_id, rp.version AS profile_version
      FROM source_documents sd
      JOIN assets a ON a.id = sd.asset_id
      LEFT JOIN research_profiles rp ON rp.id = a.primary_profile_id
      WHERE sd.storage_path = ${CANARY_SOURCE_PATH}
      LIMIT 1
    `;
    if (!source) throw new Error(`Saved canary source is not registered: ${CANARY_SOURCE_PATH}`);

    const canaryRunId = randomUUID();
    runId = canaryRunId;
    const cutoffAt = new Date().toISOString();
    const budgetUsd = process.env.RESEARCH_SOURCE_READER_CANARY_BUDGET_USD || "1.00";
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO research_runs (
          id, asset_id, run_type, status, research_question, requested_by,
          profile_id, profile_version, source_cutoff_at, market_data_cutoff_at,
          budget_limit_usd, pipeline_version, started_at, metadata_json
        ) VALUES (
          ${canaryRunId}, ${source.asset_id}, 'deep_dive', 'running',
          'Validate source-reader schema and exact citations for the saved SOFI member and product table.',
          'source-reader-canary', ${source.primary_profile_id}, ${source.profile_version || null},
          ${cutoffAt}, ${cutoffAt}, ${budgetUsd}, ${CURRENT_PIPELINE_VERSION}, NOW(),
          ${tx.json({ canary: "source-reader", source_storage_path: CANARY_SOURCE_PATH })}
        )
      `;
      await tx`
        INSERT INTO research_run_sources (research_run_id, source_document_id, role, discovery_metadata_json)
        VALUES (${canaryRunId}, ${source.id}, 'earnings_release', ${tx.json({ canary: true })})
      `;
      await tx`
        INSERT INTO research_stages (
          research_run_id, stage_key, stage_order, status, allowed_model_tiers,
          max_retries, budget_limit_usd, completion_criteria_json, validator_config_json, started_at
        ) VALUES (
          ${canaryRunId}, 'evidence_extraction', 7, 'running', ARRAY['cheap'], 0, ${budgetUsd},
          ${tx.json({ requiredOutputs: ["evidence_claims"] })}, ${tx.json({ canary: true })}, NOW()
        )
      `;
    });

    const ctx = await loadRunContext(sql, canaryRunId);
    const packetContext: RunContext = {
      runId: canaryRunId,
      runType: ctx.runType,
      assetId: ctx.assetId,
      assetName: ctx.assetName,
      assetSlug: ctx.assetSlug,
      symbol: ctx.symbol,
      profileId: ctx.profileId || "",
      profileKey: ctx.profileKey || "",
      requiredModules: [],
      requiredLenses: [],
      marketDataCutoffAt: ctx.marketDataCutoffAt?.toISOString() || null,
      pipelineVersion: CURRENT_PIPELINE_VERSION,
    };
    const storedSource: StoredSource = {
      sourceId: String(source.id),
      parseId: "",
      chunkId: "",
      content: "",
      title: String(source.title),
      sourceType: String(source.source_type),
      url: source.url ? String(source.url) : undefined,
      metadata: source.metadata_json as Record<string, unknown>,
    };
    const sourcePacket = await buildSourcePacket(sql, packetContext, [storedSource]) as SourceReaderChunk[];
    const selected = new Map<string, SourceReaderChunk>();
    for (const expected of EXPECTED_CLAIMS) {
      const chunk = sourcePacket.find((candidate) => candidate.content_excerpt.includes(expected.value));
      if (!chunk) throw new Error(`Saved source packet is missing expected value ${expected.value}`);
      selected.set(`${chunk.document_chunk_id}:${chunk.char_start}:${chunk.char_end}`, chunk);
    }
    const chunks = [...selected.values()];
    if (!chunks.some((chunk) => chunk.retrieval_scopes?.includes("member_and_product_growth"))) {
      throw new Error("Saved source packet did not retain the member_and_product_growth retrieval scope");
    }
    const batches = createSourceReaderBatches(chunks, { maxChunks: chunks.length, maxBytes: 64_000 });
    if (batches.length !== 1) throw new Error(`Canary source exceeded one bounded batch (${batches.length} batches)`);
    const batch = batches[0];
    const packet = {
      context_policy: "focused-v1",
      asset: packetContext,
      batch: {
        id: batch.id,
        count: 1,
        claim_target: EXPECTED_CLAIMS.length,
        coverage_slots: ["members_by_period", "products_by_period"],
      },
      source_corpus: batch.chunks,
    };

    const output = await callResearchAgent<Record<string, unknown>>({
      sql,
      ctx,
      stageKey: "evidence_extraction",
      taskKey: `source-reader:canary:${sourceReaderBatchFingerprint(batch, EXPECTED_CLAIMS.length)}`,
      taskType: "source_reader_canary",
      agentName: "source-reader",
      packet,
      promptFactory: (value) => buildSourceReaderPrompt(value, EXPECTED_CLAIMS.length),
      validateStructured: (value) => validateCanaryOutput(value, batch),
      policy: { maxAttempts: 1, maxRepairAttempts: 0 },
    });
    const merged = mergeSourceReaderOutputs([output], [batch]);
    const checks = {
      required_fields: true,
      source_id: true,
      document_chunk_id: true,
      exact_quote: true,
      absolute_offsets: true,
      expected_claims: EXPECTED_CLAIMS.map((expected) => ({
        ...expected,
        passed: Boolean(matchingClaim(merged.evidence_claims, expected)),
      })),
    };
    await sql.begin(async (tx) => {
      await tx`
        UPDATE research_stages
        SET status = 'completed', validation_result_json = ${tx.json(checks)}, completed_at = NOW(), updated_at = NOW()
        WHERE research_run_id = ${canaryRunId} AND stage_key = 'evidence_extraction'
      `;
      await tx`
        UPDATE research_runs
        SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = ${canaryRunId}
      `;
    });
    console.log(JSON.stringify({ runId: canaryRunId, status: "completed", checks, audit: await auditSummary(sql, canaryRunId) }, null, 2));
  } catch (error) {
    const message = redactHarnessText(error instanceof Error ? error.message : String(error), 4_000);
    if (runId) {
      const failedRunId = runId;
      await sql.begin(async (tx) => {
        await tx`
          UPDATE research_stages
          SET status = 'failed', failure_reason = ${message}, completed_at = NOW(), updated_at = NOW()
          WHERE research_run_id = ${failedRunId} AND stage_key = 'evidence_extraction'
        `;
        await tx`
          UPDATE research_runs
          SET status = 'failed', failure_reason = ${message}, completed_at = NOW(), updated_at = NOW()
          WHERE id = ${failedRunId}
        `;
      });
      console.error(JSON.stringify({ runId: failedRunId, status: "failed", error: message, audit: await auditSummary(sql, failedRunId) }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(redactHarnessText(error instanceof Error ? error.message : String(error), 4_000));
  process.exitCode = 1;
});
