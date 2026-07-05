import { NextRequest } from "next/server";
import postgres from "postgres";
import { generateValuationSignals } from "@/lib/valuation/signal-generator";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";

/**
 * POST /api/research-runs/:id/generate-signals
 * Trigger valuation signal generation based on the asset's research profile.
 * §29: recordValuationSignal domain command.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const sql = postgres(process.env.DATABASE_URL!);

    try {
      // Get run and profile info
      const runs = await sql`
        SELECT asset_id, profile_id FROM research_runs WHERE id = ${runId}
      `;
      if (runs.length === 0) {
        throw new ApiError("Research run not found", 404);
      }

      const run = runs[0];
      if (!run.profile_id) {
        throw new ApiError("No profile assigned to this run", 422);
      }

      const profiles = await sql`
        SELECT profile_key FROM research_profiles WHERE id = ${run.profile_id}
      `;
      if (profiles.length === 0) {
        throw new ApiError("Profile not found", 404);
      }

      const result = await generateValuationSignals({
        assetId: run.asset_id,
        runId,
        profileId: run.profile_id,
        profileKey: profiles[0].profile_key,
      });

      return createdResponse(result);
    } finally {
      await sql.end();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
