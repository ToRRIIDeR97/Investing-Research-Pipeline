import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { saved_charts } from "@/db/schema/saved-charts";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";
import { readJsonBody, savedChartId, toSavedChart } from "@/lib/api/saved-charts";
import { updateSavedChart } from "@/lib/research/reporting/saved-charts";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const id = savedChartId((await params).id);
    const parsed = updateSavedChart.parse(await readJsonBody(request));
    const [updated] = await db.update(saved_charts)
      .set({ ...(parsed.name !== undefined ? { name: parsed.name } : {}), ...(parsed.definition ? { definition_json: parsed.definition } : {}), updated_at: new Date() })
      .where(eq(saved_charts.id, id)).returning();
    if (!updated) throw new ApiError("Saved chart not found", 404, "NOT_FOUND");
    return successResponse(toSavedChart(updated));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const id = savedChartId((await params).id);
    const [deleted] = await db.delete(saved_charts).where(eq(saved_charts.id, id)).returning({ id: saved_charts.id });
    if (!deleted) throw new ApiError("Saved chart not found", 404, "NOT_FOUND");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
