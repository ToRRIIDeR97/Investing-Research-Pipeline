import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { getWorkerHealth } from "@/lib/research/run-queue";

export async function GET(_request: NextRequest) {
  try {
    const workers = await getWorkerHealth();
    return successResponse({
      workers,
      healthy: workers.some((worker) => worker.status === "healthy" && !worker.stale),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
