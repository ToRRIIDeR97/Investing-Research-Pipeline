import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  source_documents,
  document_parses,
  document_chunks,
  extracted_tables,
} from "@/db/schema/corpus";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { eq, count } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const [document] = await db
      .select()
      .from(source_documents)
      .where(eq(source_documents.id, id))
      .limit(1);

    if (!document) {
      throw new ApiError("Source document not found", 404, "NOT_FOUND");
    }

    const [parsesCount] = await db
      .select({ count: count() })
      .from(document_parses)
      .where(eq(document_parses.source_document_id, id));

    const [chunksCount] = await db
      .select({ count: count() })
      .from(document_chunks)
      .where(eq(document_chunks.source_document_id, id));

    const [tablesCount] = await db
      .select({ count: count() })
      .from(extracted_tables)
      .where(eq(extracted_tables.source_document_id, id));

    return successResponse({
      ...document,
      parses_count: parsesCount.count,
      chunks_count: chunksCount.count,
      tables_count: tablesCount.count,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
