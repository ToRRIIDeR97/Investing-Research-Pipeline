import { NextRequest } from "next/server";
import { db } from "@/db";
import { assets, asset_classifications, instruments, listings } from "@/db/schema/core";
import { research_profiles } from "@/db/schema/profiles";
import { handleApiError, successResponse } from "@/lib/api/errors";
import { ApiError } from "@/lib/api/errors";
import { eq, inArray } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, id))
      .limit(1);

    if (!asset) {
      throw new ApiError("Asset not found", 404, "NOT_FOUND");
    }

    const classifications = await db
      .select()
      .from(asset_classifications)
      .where(eq(asset_classifications.asset_id, id));

    const assetInstruments = await db
      .select()
      .from(instruments)
      .where(eq(instruments.asset_id, id));

    // Get listings for all instruments of this asset
    const instrumentIds = assetInstruments.map((i) => i.id);
    let assetListings: typeof listings.$inferSelect[] = [];
    if (instrumentIds.length > 0) {
      assetListings = await db
        .select()
        .from(listings)
        .where(inArray(listings.instrument_id, instrumentIds));
    }

    // Fetch assigned profile name if primary_profile_id is set
    let profileName: string | null = null;
    if (asset.primary_profile_id) {
      const [profile] = await db
        .select({ name: research_profiles.name })
        .from(research_profiles)
        .where(eq(research_profiles.id, asset.primary_profile_id))
        .limit(1);
      profileName = profile?.name ?? null;
    }

    return successResponse({
      ...asset,
      classifications,
      instruments: assetInstruments,
      listings: assetListings,
      profile_name: profileName,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
