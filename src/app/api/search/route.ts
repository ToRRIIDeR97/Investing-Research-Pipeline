import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse } from "@/lib/api/errors";

/**
 * GET /api/search
 * Hybrid search across the research corpus.
 * §12: Full-text search + metadata filters.
 *
 * Query params:
 *   q — search text (full-text search against document_chunks)
 *   asset_id — filter by asset
 *   source_type — filter by source type
 *   research_run_id — filter by research run
 *   claim_category — filter evidence claims by category (fact/estimate/assumption/opinion)
 *   confidence_min — minimum confidence threshold
 *   limit — max results (default 20)
 */
export async function GET(request: NextRequest) {
  try {
    const sql = postgres(process.env.DATABASE_URL!);
    const url = new URL(request.url);

    const query = url.searchParams.get("q");
    const assetId = url.searchParams.get("asset_id");
    const sourceType = url.searchParams.get("source_type");
    const researchRunId = url.searchParams.get("research_run_id");
    const claimCategory = url.searchParams.get("claim_category");
    const confidenceMin = url.searchParams.get("confidence_min");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);

    try {
      // If we have a text query, search document_chunks using FTS
      if (query) {
        const chunks = await sql`
          SELECT
            dc.id,
            dc.text,
            dc.section_title,
            dc.page_start,
            dc.page_end,
            sd.title as source_title,
            sd.source_type,
            sd.asset_id,
            sd.research_run_id,
            ts_rank(to_tsvector('english', dc.text), plainto_tsquery('english', ${query})) as rank
          FROM document_chunks dc
          JOIN source_documents sd ON dc.source_document_id = sd.id
          WHERE to_tsvector('english', dc.text) @@ plainto_tsquery('english', ${query})
            ${assetId ? sql`AND sd.asset_id = ${assetId}` : sql``}
            ${sourceType ? sql`AND sd.source_type = ${sourceType}` : sql``}
            ${researchRunId ? sql`AND sd.research_run_id = ${researchRunId}` : sql``}
          ORDER BY rank DESC
          LIMIT ${limit}
        `;

        return successResponse({
          type: "chunks",
          query,
          count: chunks.length,
          results: chunks,
        });
      }

      // If filtering by claim_category, search evidence claims
      if (claimCategory) {
        const claims = await sql`
          SELECT
            ec.id,
            ec.claim_text,
            ec.claim_type,
            ec.claim_category,
            ec.confidence,
            ec.review_status,
            ec.generated_by,
            ec.created_at,
            a.canonical_name as asset_name
          FROM evidence_claims ec
          JOIN assets a ON ec.asset_id = a.id
          WHERE ec.claim_category = ${claimCategory}
            ${assetId ? sql`AND ec.asset_id = ${assetId}` : sql``}
            ${researchRunId ? sql`AND ec.research_run_id = ${researchRunId}` : sql``}
            ${confidenceMin ? sql`AND ec.confidence >= ${confidenceMin}` : sql``}
          ORDER BY ec.confidence DESC NULLS LAST, ec.created_at DESC
          LIMIT ${limit}
        `;

        return successResponse({
          type: "evidence_claims",
          claimCategory,
          count: claims.length,
          results: claims,
        });
      }

      // Default: search across evidence claims by text
      if (!query && !claimCategory) {
        return successResponse({
          type: "empty",
          message: "Provide ?q= for full-text search or ?claim_category=fact|estimate|assumption|opinion",
        });
      }
    } finally {
      await sql.end();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
