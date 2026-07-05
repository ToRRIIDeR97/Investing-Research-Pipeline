import { NextRequest } from "next/server";
import { db } from "@/db";
import { assets } from "@/db/schema/core";
import { handleApiError, successResponse, createdResponse } from "@/lib/api/errors";
import { createAssetSchema } from "@/lib/api/validation";
import { ApiError } from "@/lib/api/errors";
import { eq, asc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const kind = searchParams.get("kind");

    let results;
    if (kind) {
      results = await db
        .select()
        .from(assets)
        .where(eq(assets.asset_kind, kind))
        .orderBy(asc(assets.canonical_name));
    } else {
      results = await db
        .select()
        .from(assets)
        .orderBy(asc(assets.canonical_name));
    }

    return successResponse(results);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createAssetSchema.parse(body);

    // Check for slug uniqueness
    const existing = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.slug, parsed.slug))
      .limit(1);

    if (existing.length > 0) {
      throw new ApiError("Asset with this slug already exists", 409, "DUPLICATE_SLUG");
    }

    const [created] = await db
      .insert(assets)
      .values({
        canonical_name: parsed.canonical_name,
        slug: parsed.slug,
        asset_kind: parsed.asset_kind,
        base_currency: parsed.base_currency ?? null,
        home_country: parsed.home_country ?? null,
        sector: parsed.sector ?? null,
        industry: parsed.industry ?? null,
        description: parsed.description ?? null,
      })
      .returning();

    return createdResponse(created);
  } catch (error) {
    return handleApiError(error);
  }
}
