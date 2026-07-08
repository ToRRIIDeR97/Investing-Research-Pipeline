import { NextRequest } from "next/server";
import { db } from "@/db";
import { metric_definitions, metric_observations } from "@/db/schema/metrics";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const observations = await db
      .select({
        id: metric_observations.id,
        asset_id: metric_observations.asset_id,
        research_run_id: metric_observations.research_run_id,
        metric_definition_id: metric_observations.metric_definition_id,
        period_start: metric_observations.period_start,
        period_end: metric_observations.period_end,
        as_of_date: metric_observations.as_of_date,
        available_at: metric_observations.available_at,
        published_at: metric_observations.published_at,
        retrieved_at: metric_observations.retrieved_at,
        value_numeric: metric_observations.value_numeric,
        value_text: metric_observations.value_text,
        unit: metric_observations.unit,
        currency: metric_observations.currency,
        data_provider: metric_observations.data_provider,
        source_document_id: metric_observations.source_document_id,
        evidence_claim_id: metric_observations.evidence_claim_id,
        calculation_json: metric_observations.calculation_json,
        confidence: metric_observations.confidence,
        revision_number: metric_observations.revision_number,
        is_revised: metric_observations.is_revised,
        review_status: metric_observations.review_status,
        metadata_json: metric_observations.metadata_json,
        created_at: metric_observations.created_at,
        supersedes_id: metric_observations.supersedes_id,
        metric_key: metric_definitions.metric_key,
        metric_display_name: metric_definitions.display_name,
        metric_category: metric_definitions.metric_category,
        unit_type: metric_definitions.unit_type,
      })
      .from(metric_observations)
      .leftJoin(
        metric_definitions,
        eq(metric_observations.metric_definition_id, metric_definitions.id)
      )
      .where(eq(metric_observations.research_run_id, runId))
      .orderBy(desc(metric_observations.created_at));

    return successResponse(observations);
  } catch (error) {
    return handleApiError(error);
  }
}
