import { handleApiError, successResponse } from "@/lib/api/errors";
import { listAssetOverviews } from "@/lib/research/asset-overview";

export const dynamic = "force-dynamic";

/** Research assets with their newest run and key numbers (price, case values, targets, KPIs) for cards and lists. */
export async function GET() {
  try {
    return successResponse(await listAssetOverviews());
  } catch (error) {
    return handleApiError(error);
  }
}
