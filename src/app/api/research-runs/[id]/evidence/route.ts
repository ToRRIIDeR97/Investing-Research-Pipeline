import { NextRequest } from "next/server";
import { db } from "@/db";
import { evidence_claims } from "@/db/schema/evidence";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, and, desc } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    const conditions = [eq(evidence_claims.research_run_id, runId)];
    if (status) {
      conditions.push(eq(evidence_claims.review_status, status));
    }

    const claims = await db
      .select()
      .from(evidence_claims)
      .where(and(...conditions))
      .orderBy(desc(evidence_claims.created_at));

    return successResponse(claims);
  } catch (error) {
    return handleApiError(error);
  }
}
