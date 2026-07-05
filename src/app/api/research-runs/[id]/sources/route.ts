import { NextRequest } from "next/server";
import { db } from "@/db";
import { source_documents } from "@/db/schema/corpus";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const sources = await db
      .select()
      .from(source_documents)
      .where(eq(source_documents.research_run_id, runId))
      .orderBy(desc(source_documents.created_at));

    return successResponse(sources);
  } catch (error) {
    return handleApiError(error);
  }
}
