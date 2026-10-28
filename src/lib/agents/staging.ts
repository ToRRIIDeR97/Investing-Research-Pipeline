import postgres from "postgres";
import { z } from "zod";

// ============================================================
// Staging service — §9.2
// Agent outputs flow through staging → validation → accept/reject → final tables.
// ============================================================

export const evidenceClaimPayloadSchema = z.object({
  claim_text: z.string().min(1),
  claim_type: z.string().min(1),
  claim_category: z.enum(["fact", "estimate", "assumption", "opinion"]),
  polarity: z.string().optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  as_of_date: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  no_source_reason: z.string().optional(),
  source_document_id: z.string().guid().optional(),
  document_chunk_id: z.string().guid().optional(),
  extracted_table_id: z.string().guid().optional(),
  page_start: z.number().int().optional(),
  page_end: z.number().int().optional(),
  char_start: z.number().int().optional(),
  char_end: z.number().int().optional(),
  quoted_text: z.string().optional(),
  support_type: z.enum(["supports", "contradicts", "context", "calculation_source"]).optional(),
});

export const metricObservationPayloadSchema = z.object({
  metric_key: z.string().min(1),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  as_of_date: z.string().optional(),
  value_numeric: z.number().optional(),
  value_text: z.string().optional(),
  unit: z.string().optional(),
  currency: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source_document_id: z.string().guid().optional(),
  evidence_claim_id: z.string().guid().optional(),
});

export const valuationSignalPayloadSchema = z.object({
  signal_key: z.string().min(1),
  signal_name: z.string().min(1),
  lens_family: z.string().min(1),
  current_value: z.number().optional(),
  current_value_text: z.string().optional(),
  percentile: z.number().optional(),
  z_score: z.number().optional(),
  cheaper_when: z.string().optional(),
  signal: z.enum([
    "very_cheap",
    "cheap",
    "neutral",
    "expensive",
    "very_expensive",
    "inconclusive",
    "not_applicable",
  ]),
  cheapness_score: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  valuation_method_id: z.string().guid().optional(),
  metric_definition_id: z.string().guid().optional(),
  source_document_id: z.string().guid().optional(),
  evidence_claim_id: z.string().guid().optional(),
});

const SCHEMA_MAP: Record<string, z.ZodType> = {
  evidence_claim: evidenceClaimPayloadSchema,
  metric_observation: metricObservationPayloadSchema,
  valuation_signal: valuationSignalPayloadSchema,
};

export const STAGED_SCHEMA_KEYS = Object.keys(SCHEMA_MAP);

/**
 * Every check a staged output must pass before it can be accepted: the payload schema and, for an
 * evidence claim that isn't an assumption, a source location or a no_source_reason (#122).
 * Returns null for a schema key with no payload schema, which acceptance couldn't promote.
 */
export function stagedOutputErrors(outputSchemaKey: string, payload: unknown): string[] | null {
  const schema = Object.hasOwn(SCHEMA_MAP, outputSchemaKey) ? SCHEMA_MAP[outputSchemaKey] : undefined;
  if (!schema) return null;
  const result = schema.safeParse(payload);
  if (!result.success) return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  const claim = payload as Record<string, unknown>;
  if (
    outputSchemaKey === "evidence_claim" &&
    claim.claim_category !== "assumption" &&
    !claim.document_chunk_id &&
    !claim.extracted_table_id &&
    !claim.source_document_id &&
    !claim.no_source_reason
  ) {
    return ["Non-assumption claims require a source location (document, chunk, or table) or no_source_reason"];
  }
  return [];
}

export class UnknownSchemaKeyError extends Error {
  constructor(public schemaKey: string) {
    super(`Unknown output_schema_key "${schemaKey}". Expected one of: ${STAGED_SCHEMA_KEYS.join(", ")}`);
    this.name = "UnknownSchemaKeyError";
  }
}

/**
 * Stage an agent output, validated with the same checks validateStagedOutput applies.
 */
export async function stageOutput(params: {
  runId: string;
  stageId: string;
  taskId: string;
  targetTable: string;
  outputSchemaKey: string;
  outputSchemaVersion: number;
  payload: Record<string, unknown>;
  createdByAgent: string;
}): Promise<{ stagingId: string; validationStatus: string; errors: string[] }> {
  // Checked before connecting, so a caller can answer 400 without touching the database.
  const errors = stagedOutputErrors(params.outputSchemaKey, params.payload);
  if (!errors) throw new UnknownSchemaKeyError(params.outputSchemaKey);
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const validationStatus = errors.length === 0 ? "valid" : "invalid";

    const rows = await sql`
      INSERT INTO agent_output_staging (
        research_run_id, stage_id, task_id,
        target_table, output_schema_key, output_schema_version,
        payload_json, validation_status, validation_errors_json,
        created_by_agent
      ) VALUES (
        ${params.runId}, ${params.stageId}, ${params.taskId},
        ${params.targetTable}, ${params.outputSchemaKey}, ${params.outputSchemaVersion},
        ${sql.json(params.payload as any)}, ${validationStatus}, ${sql.json(errors)},
        ${params.createdByAgent}
      )
      RETURNING id
    `;

    return { stagingId: rows[0].id, validationStatus, errors };
  } finally {
    await sql.end();
  }
}

/**
 * Validate a staged output: schema validation + source link check.
 */
export async function validateStagedOutput(stagingId: string): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const rows = await sql`
      SELECT * FROM agent_output_staging WHERE id = ${stagingId}
    `;

    if (rows.length === 0) {
      return { valid: false, errors: ["Staging record not found"] };
    }

    const staging = rows[0];
    const errors = stagedOutputErrors(staging.output_schema_key, staging.payload_json)
      ?? [`Unknown output_schema_key: ${staging.output_schema_key}`];

    const valid = errors.length === 0;

    // Update validation status
    await sql`
      UPDATE agent_output_staging
      SET validation_status = ${valid ? "valid" : "invalid"},
          validation_errors_json = ${sql.json(errors)}
      WHERE id = ${stagingId}
    `;

    return { valid, errors };
  } finally {
    await sql.end();
  }
}

/**
 * Accept a staged output and promote it to the target table. Only an output that passed
 * validation and is not yet accepted or rejected is promoted, and only once: the claim, the
 * insert and the final status share one transaction. Returns null when no such row exists.
 */
export async function acceptStagedOutput(
  stagingId: string
): Promise<{ recordId: string } | null> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    return await sql.begin(async (tx) => {
      // The claim locks the row, so a concurrent accept waits and then finds it accepted.
      const [staging] = await tx`
        UPDATE agent_output_staging
        SET review_status = 'accepting'
        WHERE id = ${stagingId}
          AND validation_status = 'valid'
          AND review_status IS DISTINCT FROM 'accepted'
          AND review_status IS DISTINCT FROM 'rejected'
        RETURNING *
      `;
      if (!staging) return null;
      const payload = staging.payload_json;

      let recordId: string;

      switch (staging.output_schema_key) {
        case "evidence_claim": {
          const inserted = await tx`
            INSERT INTO evidence_claims (
              asset_id, research_run_id, claim_text, claim_type,
              claim_category, polarity, period_start, period_end,
              as_of_date, confidence, generated_by, review_status,
              no_source_reason
            ) VALUES (
              (SELECT asset_id FROM research_runs WHERE id = ${staging.research_run_id}),
              ${staging.research_run_id},
              ${payload.claim_text}, ${payload.claim_type},
              ${payload.claim_category}, ${payload.polarity || null},
              ${payload.period_start || null}, ${payload.period_end || null},
              ${payload.as_of_date || null}, ${payload.confidence || null},
              ${staging.created_by_agent}, 'pending',
              ${payload.no_source_reason || null}
            )
            RETURNING id
          `;

          const claimId = inserted[0].id;

          if (payload.source_document_id || payload.document_chunk_id || payload.extracted_table_id) {
            const sourceDocumentId =
              payload.source_document_id ||
              (payload.document_chunk_id
                ? await tx`
                    SELECT source_document_id
                    FROM document_chunks
                    WHERE id = ${payload.document_chunk_id}
                  `.then((rows) => rows[0]?.source_document_id)
                : null) ||
              (payload.extracted_table_id
                ? await tx`
                    SELECT source_document_id
                    FROM extracted_tables
                    WHERE id = ${payload.extracted_table_id}
                  `.then((rows) => rows[0]?.source_document_id)
                : null);

            if (!sourceDocumentId) {
              throw new Error("Could not resolve source_document_id for evidence link");
            }

            const sourceLocation = await tx`
              INSERT INTO source_locations (
                source_document_id, document_chunk_id, extracted_table_id,
                page_start, page_end, char_start, char_end
              ) VALUES (
                ${sourceDocumentId},
                ${payload.document_chunk_id || null},
                ${payload.extracted_table_id || null},
                ${payload.page_start || null},
                ${payload.page_end || null},
                ${payload.char_start || null},
                ${payload.char_end || null}
              )
              RETURNING id
            `;

            await tx`
              INSERT INTO evidence_links (
                evidence_claim_id, source_location_id, support_type,
                quoted_text, confidence
              ) VALUES (
                ${claimId},
                ${sourceLocation[0].id},
                ${payload.support_type || "supports"},
                ${payload.quoted_text || null},
                ${payload.confidence || null}
              )
            `;
          }

          recordId = claimId;
          break;
        }
        case "metric_observation": {
          // Look up metric_definition_id from metric_key
          const metricDef = await tx`
            SELECT id FROM metric_definitions WHERE metric_key = ${payload.metric_key}
          `;
          if (metricDef.length === 0) throw new Error(`Unknown metric_key: ${payload.metric_key}`);

          const inserted = await tx`
            INSERT INTO metric_observations (
              asset_id, research_run_id, metric_definition_id,
              period_start, period_end, as_of_date,
              value_numeric, value_text, unit, currency,
              confidence, source_document_id, evidence_claim_id, review_status
            ) VALUES (
              (SELECT asset_id FROM research_runs WHERE id = ${staging.research_run_id}),
              ${staging.research_run_id}, ${metricDef[0].id},
              ${payload.period_start || null}, ${payload.period_end || null},
              ${payload.as_of_date || null},
              ${payload.value_numeric?.toString() || null}, ${payload.value_text || null},
              ${payload.unit || null}, ${payload.currency || null},
              ${payload.confidence?.toString() || null},
              ${payload.source_document_id || null}, ${payload.evidence_claim_id || null},
              'pending'
            )
            RETURNING id
          `;
          recordId = inserted[0].id;
          break;
        }
        case "valuation_signal": {
          const run = await tx`
            SELECT asset_id, profile_id FROM research_runs WHERE id = ${staging.research_run_id}
          `;
          if (run.length === 0) throw new Error("Run not found");
          if (!run[0].profile_id) throw new Error("Run has no profile_id; valuation signals require a research profile");

          const inserted = await tx`
            INSERT INTO valuation_signals (
              asset_id, research_run_id, profile_id,
              valuation_method_id, metric_definition_id,
              signal_key, signal_name, lens_family,
              current_value, current_value_text,
              percentile, z_score, cheaper_when,
              signal, cheapness_score, confidence,
              source_document_id, evidence_claim_id,
              review_status
            ) VALUES (
              ${run[0].asset_id}, ${staging.research_run_id}, ${run[0].profile_id || null},
              ${payload.valuation_method_id || null}, ${payload.metric_definition_id || null},
              ${payload.signal_key}, ${payload.signal_name}, ${payload.lens_family},
              ${payload.current_value?.toString() || null}, ${payload.current_value_text || null},
              ${payload.percentile?.toString() || null}, ${payload.z_score?.toString() || null}, ${payload.cheaper_when || null},
              ${payload.signal}, ${payload.cheapness_score?.toString() || null}, ${payload.confidence?.toString() || null},
              ${payload.source_document_id || null}, ${payload.evidence_claim_id || null},
              'pending'
            )
            RETURNING id
          `;
          recordId = inserted[0].id;
          break;
        }
        default:
          throw new Error(`Unsupported schema key: ${staging.output_schema_key}`);
      }

      // Mark staging as accepted
      await tx`
        UPDATE agent_output_staging
        SET validation_status = 'accepted',
            review_status = 'accepted',
            target_record_id = ${recordId},
            accepted_at = NOW()
        WHERE id = ${stagingId}
      `;

      return { recordId };
    });
  } finally {
    await sql.end();
  }
}

/**
 * Reject a staged output that is not yet accepted or rejected (#122). An accepted row keeps its
 * status, since its promoted record stays. Returns "not_found" for a missing id and
 * "not_rejectable" when the row was already reviewed or is being accepted.
 */
export async function rejectStagedOutput(
  stagingId: string,
  reason: string
): Promise<"rejected" | "not_found" | "not_rejectable"> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const [row] = await sql`
      UPDATE agent_output_staging
      SET validation_status = 'rejected',
          review_status = 'rejected',
          rejected_at = NOW(),
          rejection_reason = ${reason}
      WHERE id = ${stagingId}
        AND review_status IS DISTINCT FROM 'accepted'
        AND review_status IS DISTINCT FROM 'accepting'
        AND review_status IS DISTINCT FROM 'rejected'
      RETURNING id
    `;
    if (row) return "rejected";
    const [existing] = await sql`SELECT id FROM agent_output_staging WHERE id = ${stagingId}`;
    return existing ? "not_rejectable" : "not_found";
  } finally {
    await sql.end();
  }
}
