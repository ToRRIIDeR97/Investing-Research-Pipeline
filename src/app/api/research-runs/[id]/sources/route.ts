import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_run_sources, source_documents } from "@/db/schema/corpus";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc, or } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const rows = await db
      .select({ source: source_documents })
      .from(source_documents)
      .leftJoin(research_run_sources, eq(research_run_sources.source_document_id, source_documents.id))
      .where(or(
        eq(source_documents.research_run_id, runId),
        eq(research_run_sources.research_run_id, runId)
      ))
      .orderBy(desc(source_documents.created_at));
    const sources = [...new Map(rows.map((row) => [row.source.id, row.source])).values()];

    return successResponse(sources);
  } catch (error) {
    return handleApiError(error);
  }
}
