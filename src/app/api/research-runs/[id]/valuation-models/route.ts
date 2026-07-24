import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { valuation_artifacts, valuation_model_runs } from "@/db/schema/research-v2";
import { handleApiError, successResponse } from "@/lib/api/errors";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const rows = await db
      .select({ model: valuation_model_runs, artifact: valuation_artifacts })
      .from(valuation_model_runs)
      .leftJoin(valuation_artifacts, eq(valuation_artifacts.valuation_model_run_id, valuation_model_runs.id))
      .where(eq(valuation_model_runs.research_run_id, id))
      .orderBy(desc(valuation_model_runs.created_at));
    const models = new Map<string, { model: typeof valuation_model_runs.$inferSelect; artifacts: typeof valuation_artifacts.$inferSelect[] }>();
    for (const row of rows) {
      const current = models.get(row.model.id) || { model: row.model, artifacts: [] };
      if (row.artifact) current.artifacts.push(row.artifact);
      models.set(row.model.id, current);
    }
    return successResponse([...models.values()]);
  } catch (error) {
    return handleApiError(error);
  }
}
