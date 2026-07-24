import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { indicator_definitions, indicator_observations } from "@/db/schema/research-v2";
import { handleApiError, successResponse } from "@/lib/api/errors";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const rows = await db
      .select({ definition: indicator_definitions, observation: indicator_observations })
      .from(indicator_definitions)
      .leftJoin(indicator_observations, eq(indicator_observations.indicator_definition_id, indicator_definitions.id))
      .where(eq(indicator_definitions.research_run_id, id))
      .orderBy(desc(indicator_observations.available_at));
    const indicators = new Map<string, { definition: typeof indicator_definitions.$inferSelect; observations: typeof indicator_observations.$inferSelect[] }>();
    for (const row of rows) {
      const current = indicators.get(row.definition.id) || { definition: row.definition, observations: [] };
      if (row.observation) current.observations.push(row.observation);
      indicators.set(row.definition.id, current);
    }
    return successResponse([...indicators.values()]);
  } catch (error) {
    return handleApiError(error);
  }
}
