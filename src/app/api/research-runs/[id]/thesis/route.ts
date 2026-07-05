import { NextRequest } from "next/server";
import { db } from "@/db";
import { theses, thesis_drivers } from "@/db/schema/thesis";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { eq, inArray, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    const runTheses = await db
      .select()
      .from(theses)
      .where(eq(theses.research_run_id, runId))
      .orderBy(desc(theses.created_at));

    // Fetch all drivers for these theses in one query
    const thesisIds = runTheses.map((t) => t.id);
    let allDrivers: typeof thesis_drivers.$inferSelect[] = [];
    if (thesisIds.length > 0) {
      allDrivers = await db
        .select()
        .from(thesis_drivers)
        .where(inArray(thesis_drivers.thesis_id, thesisIds))
        .orderBy(desc(thesis_drivers.created_at));
    }

    // Group drivers by thesis_id
    const driversByThesis = new Map<string, typeof allDrivers>();
    for (const driver of allDrivers) {
      const list = driversByThesis.get(driver.thesis_id) ?? [];
      list.push(driver);
      driversByThesis.set(driver.thesis_id, list);
    }

    const thesesWithDrivers = runTheses.map((thesis) => ({
      ...thesis,
      drivers: driversByThesis.get(thesis.id) ?? [],
    }));

    return successResponse(thesesWithDrivers);
  } catch (error) {
    return handleApiError(error);
  }
}
