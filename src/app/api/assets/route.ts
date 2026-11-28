import { NextRequest } from "next/server";
import { db } from "@/db";
import { pipelineSql } from "@/db/pipeline-sql";
import { assets } from "@/db/schema/core";
import { handleApiError, successResponse, createdResponse } from "@/lib/api/errors";
import { createAssetSchema } from "@/lib/api/validation";
import { ApiError } from "@/lib/api/errors";
import { and, eq, asc, ne } from "drizzle-orm";
import { isTestAsset } from "@/lib/research/test-assets";
import { defaultProfileKeyFor, profileIdForKey } from "@/lib/research/asset-profile";

/** Listing symbols per asset (upper-cased), so a search result can be matched to a company you already have. */
async function symbolsByAsset(): Promise<Map<string, string[]>> {
  const rows = await pipelineSql()`
    SELECT i.asset_id, array_agg(DISTINCT upper(l.symbol)) AS symbols
    FROM listings l JOIN instruments i ON i.id = l.instrument_id
    GROUP BY i.asset_id`;
  return new Map(rows.map((r) => [String(r.asset_id), (r.symbols as string[]).filter(Boolean)]));
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const kind = searchParams.get("kind");

    let results;
    if (kind) {
      results = await db
        .select()
        .from(assets)
        .where(and(eq(assets.asset_kind, kind), ne(assets.status, "reference")))
        .orderBy(asc(assets.canonical_name));
    } else {
      // Reference assets (the beta benchmark) hold market data only and are not research subjects.
      results = await db
        .select()
        .from(assets)
        .where(ne(assets.status, "reference"))
        .orderBy(asc(assets.canonical_name));
    }

    const symbols = await symbolsByAsset();
    // Test assets (end-to-end fixtures) stay out of search and the Start research list; a direct URL still opens them.
    return successResponse(results.filter((asset) => !isTestAsset(asset)).map((asset) => ({ ...asset, symbols: symbols.get(asset.id) ?? [] })));
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
      throw new ApiError("Asset with this slug already exists", 409, "DUPLICATE_SLUG", { existing_id: existing[0].id });
    }

    // The slug is the ticker for an equity: a company that already lists it (seeded Apple has slug "apple" and
    // listing AAPL) is the same company, not a new one.
    if (parsed.asset_kind === "equity") {
      const [listed] = await pipelineSql()`
        SELECT a.id FROM listings l JOIN instruments i ON i.id = l.instrument_id JOIN assets a ON a.id = i.asset_id
        WHERE upper(l.symbol) = ${parsed.slug.toUpperCase()} AND a.status IS DISTINCT FROM 'reference'
        ORDER BY a.created_at LIMIT 1`;
      if (listed) throw new ApiError("A company with this ticker already exists", 409, "DUPLICATE_LISTING", { existing_id: String(listed.id) });
    }

    // Every run's first stage needs a research profile; pick the seeded one for the kind.
    const profileId = await profileIdForKey(pipelineSql(), defaultProfileKeyFor(parsed.asset_kind, parsed.sector, parsed.slug));

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
        primary_profile_id: profileId,
      })
      .returning();

    return createdResponse(created);
  } catch (error) {
    return handleApiError(error);
  }
}
