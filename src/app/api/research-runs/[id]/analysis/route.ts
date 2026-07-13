import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { analysis_sections } from "@/db/schema/research-v2";
import { handleApiError, successResponse } from "@/lib/api/errors";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sections = await db
      .select()
      .from(analysis_sections)
      .where(eq(analysis_sections.research_run_id, id))
      .orderBy(desc(analysis_sections.updated_at));
    return successResponse(sections);
  } catch (error) {
    return handleApiError(error);
  }
}
