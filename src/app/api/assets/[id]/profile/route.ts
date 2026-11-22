import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";
import { lookupCompanyProfiles } from "@/lib/company-profiles/store";

/** The asset's company profile (logo, website, leadership), or null when none was found. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError("Asset not found", 404, "NOT_FOUND");
    const { keys, profiles } = await lookupCompanyProfiles([{ asset_id: id }]);
    if (!keys[0]) throw new ApiError("Asset not found", 404, "NOT_FOUND");
    return successResponse(profiles[keys[0]] ?? null);
  } catch (error) {
    return handleApiError(error);
  }
}
