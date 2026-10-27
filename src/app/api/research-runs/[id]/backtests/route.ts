import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs } from "@/db/schema/workflow";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import {
  createBacktestRequest,
  listBacktestsForRun,
} from "@/lib/backtesting/service";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// `?summary=1` returns only the list fields (see BACKTEST_SUMMARY_FIELDS); the run page polls it.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    if (!uuidPattern.test(runId)) {
      throw new ApiError("Invalid research run id", 400, "VALIDATION_ERROR");
    }

    // Verify the research run exists
    const [run] = await db
      .select({ id: research_runs.id })
      .from(research_runs)
      .where(eq(research_runs.id, runId))
      .limit(1);

    if (!run) {
      throw new ApiError("Research run not found", 404, "NOT_FOUND");
    }

    const backtests = request.nextUrl.searchParams.get("summary") === "1"
      ? await listBacktestsForRun(runId, { summary: true })
      : await listBacktestsForRun(runId);

    return successResponse(backtests);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;
    if (!uuidPattern.test(runId)) {
      throw new ApiError("Invalid research run id", 400, "VALIDATION_ERROR");
    }

    const body = await request.json();
    const backtest = await createBacktestRequest(runId, body);

    return createdResponse(backtest);
  } catch (error) {
    if (error instanceof ZodError) {
      return handleApiError(
        new ApiError(error.issues[0]?.message || "Invalid backtest request", 400, "VALIDATION_ERROR")
      );
    }
    if (error instanceof Error) {
      const status = error.message.toLowerCase().includes("not found") ? 404 : 400;
      return handleApiError(new ApiError(error.message, status, "BACKTEST_REQUEST_ERROR"));
    }
    return handleApiError(error);
  }
}
