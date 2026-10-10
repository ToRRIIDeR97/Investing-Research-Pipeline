import { NextRequest } from "next/server";
import { asc, count } from "drizzle-orm";
import { db } from "@/db";
import { saved_charts } from "@/db/schema/saved-charts";
import { ApiError, createdResponse, handleApiError, successResponse } from "@/lib/api/errors";
import { MAX_SAVED_CHARTS, readJsonBody, toSavedChart } from "@/lib/api/saved-charts";
import { createSavedChart } from "@/lib/research/reporting/saved-charts";

export async function GET() {
  try {
    const rows = await db.select().from(saved_charts).orderBy(asc(saved_charts.created_at), asc(saved_charts.id));
    return successResponse(rows.map(toSavedChart).filter(Boolean));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = createSavedChart.parse(await readJsonBody(request));
    const [{ total }] = await db.select({ total: count() }).from(saved_charts);
    if (total >= MAX_SAVED_CHARTS) throw new ApiError(`My charts holds at most ${MAX_SAVED_CHARTS} charts. Delete one first.`, 409, "TOO_MANY_CHARTS");
    const [created] = await db.insert(saved_charts).values({ name: parsed.name, definition_json: parsed.definition }).returning();
    return createdResponse(toSavedChart(created));
  } catch (error) {
    return handleApiError(error);
  }
}
