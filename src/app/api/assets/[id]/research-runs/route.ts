import { NextRequest } from "next/server";
import { db } from "@/db";
import { assets } from "@/db/schema/core";
import { asset_profile_assignments, research_profiles } from "@/db/schema/profiles";
import { research_runs } from "@/db/schema/workflow";
import { handleApiError, successResponse, createdResponse, ApiError } from "@/lib/api/errors";
import { createResearchRunSchema } from "@/lib/api/validation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { createStagesForRun } from "@/lib/workflow/orchestrator";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assetId } = await params;

    const runs = await db
      .select()
      .from(research_runs)
      .where(eq(research_runs.asset_id, assetId))
      .orderBy(asc(research_runs.created_at));

    return successResponse(runs);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assetId } = await params;

    // Verify the asset exists
    const [asset] = await db
      .select({ id: assets.id, primary_profile_id: assets.primary_profile_id })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

    if (!asset) {
      throw new ApiError("Asset not found", 404, "NOT_FOUND");
    }

    const body = await request.json();
    const parsed = createResearchRunSchema.parse(body);
    const profileId =
      parsed.profile_id ?? asset.primary_profile_id ?? (await resolveActiveProfileId(assetId));
    const profileVersion = profileId ? await resolveProfileVersion(profileId) : null;

    const [run] = await db
      .insert(research_runs)
      .values({
        asset_id: assetId,
        run_type: parsed.run_type,
        research_question: parsed.research_question ?? null,
        requested_by: parsed.requested_by ?? null,
        profile_id: profileId,
        profile_version: profileVersion,
        budget_limit_usd: parsed.budget_limit_usd?.toString() ?? null,
        source_cutoff_at: parsed.source_cutoff_at
          ? new Date(parsed.source_cutoff_at)
          : null,
        market_data_cutoff_at: parsed.market_data_cutoff_at
          ? new Date(parsed.market_data_cutoff_at)
          : null,
      })
      .returning();

    // Create all workflow stages, including explicit skipped stages for auditability.
    await createStagesForRun(run.id);

    return createdResponse(run);
  } catch (error) {
    return handleApiError(error);
  }
}

async function resolveActiveProfileId(assetId: string) {
  const [assignment] = await db
    .select({ profile_id: asset_profile_assignments.profile_id })
    .from(asset_profile_assignments)
    .where(
      and(
        eq(asset_profile_assignments.asset_id, assetId),
        eq(asset_profile_assignments.status, "active"),
        isNull(asset_profile_assignments.research_run_id)
      )
    )
    .orderBy(desc(asset_profile_assignments.created_at))
    .limit(1);

  return assignment?.profile_id ?? null;
}

async function resolveProfileVersion(profileId: string) {
  const [profile] = await db
    .select({ version: research_profiles.version })
    .from(research_profiles)
    .where(eq(research_profiles.id, profileId))
    .limit(1);

  return profile?.version ?? null;
}
