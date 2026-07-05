import { NextRequest } from "next/server";
import { db } from "@/db";
import { valuation_signals } from "@/db/schema/valuation";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const signals = await db
      .select()
      .from(valuation_signals)
      .where(eq(valuation_signals.research_run_id, runId))
      .orderBy(desc(valuation_signals.created_at));

    return successResponse(signals);
  } catch (error) {
    return handleApiError(error);
  }
}
