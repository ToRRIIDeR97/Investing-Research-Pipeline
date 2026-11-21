import { NextRequest } from "next/server";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { listFilings, requireFilingsAsset } from "@/lib/api/filings";

type Params = { params: Promise<{ id: string }> };

/** The asset's stored primary filings from the last two years (10-K, 10-Q, 20-F, 40-F, 6-K, 8-K), newest first. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    return successResponse(await listFilings(await requireFilingsAsset((await params).id)));
  } catch (error) {
    return handleApiError(error);
  }
}
