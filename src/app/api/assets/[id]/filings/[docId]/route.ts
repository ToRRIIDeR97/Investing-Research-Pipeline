import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { filingOutline, filingSection, requireFilingsAsset } from "@/lib/api/filings";

type Params = { params: Promise<{ id: string; docId: string }> };

/** A filing's compressed outline, or with `?section=<n>` that section's full text. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id, docId } = await params;
    const assetId = await requireFilingsAsset(id);
    const section = request.nextUrl.searchParams.get("section");
    return successResponse(section === null ? await filingOutline(assetId, docId) : await filingSection(assetId, docId, section));
  } catch (error) {
    return handleApiError(error);
  }
}
