import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { loadNotebook, requireAsset } from "@/lib/api/notebook";

/** The asset's notebook: pins, KPIs, report annotations and journal entries (references and text, no values). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const assetId = await requireAsset((await params).id);
    return successResponse(await loadNotebook(assetId));
  } catch (error) {
    return handleApiError(error);
  }
}
