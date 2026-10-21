import { NextRequest } from "next/server";
import postgres from "postgres";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { latestMonitorCheck } from "@/lib/research/monitoring/monitor-check";

/** The latest stored monitor-check result for the asset, or null. Read-only: checks run from npm run monitor:check. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: assetId } = await params;
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(assetId)) return successResponse(null);
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return successResponse(await latestMonitorCheck(sql, assetId));
    } finally {
      await sql.end();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
