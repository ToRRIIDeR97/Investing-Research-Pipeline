import { NextRequest } from "next/server";
import { generateMemo } from "@/lib/export/memo-generator";
import { handleApiError, createdResponse, ApiError } from "@/lib/api/errors";
import postgres from "postgres";

/**
 * POST /api/research-runs/:id/export
 * Generate a research memo from accepted database records.
 * §5.9: Markdown is a rendering target, not the source of truth.
 * §29: generateExport domain command.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    const sql = postgres(process.env.DATABASE_URL!);

    try {
      // Verify the research run exists
      const [run] = await sql`
        SELECT id, asset_id FROM research_runs WHERE id = ${runId}
      `;
      if (!run) {
        throw new ApiError("Research run not found", 404);
      }

      // Generate the memo from database records
      const result = await generateMemo({
        runId,
        assetId: run.asset_id,
        generatedBy: "api",
      });

      return createdResponse(result);
    } finally {
      await sql.end();
    }
  } catch (error) {
    return handleApiError(error);
  }
}
