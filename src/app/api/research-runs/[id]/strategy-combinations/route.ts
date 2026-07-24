import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { strategy_combinations } from "@/db/schema/research-v2";
import { handleApiError, successResponse } from "@/lib/api/errors";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const combinations = await db
      .select()
      .from(strategy_combinations)
      .where(eq(strategy_combinations.research_run_id, id))
      .orderBy(desc(strategy_combinations.completed_at));
    return successResponse(combinations);
  } catch (error) {
    return handleApiError(error);
  }
}
