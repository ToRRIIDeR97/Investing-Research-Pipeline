import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { pipelineSql } from "@/db/pipeline-sql";
import { defaultProfileKeyFor, profileIdForKey } from "../asset-profile";

export const assetIdentityHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "asset_identity",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = pipelineSql();
    const assetRows = await sql`
      SELECT primary_profile_id, asset_kind, sector, slug FROM assets WHERE id = ${ctx.assetId}
    `;
    if (assetRows.length === 0) {
      throw new Error(`Asset not found: ${ctx.assetId}`);
    }
    // An asset added before profiles were assigned on creation has none: use the run's profile, else the default
    // for its kind, and keep it on the asset so later runs start from it.
    let profileId = assetRows[0].primary_profile_id as string | null;
    if (!profileId) {
      const a = assetRows[0];
      profileId = ctx.profileId ?? await profileIdForKey(sql, defaultProfileKeyFor(a.asset_kind, a.sector, a.slug));
      if (!profileId) {
        throw new Error(`Asset has no primary profile and no default profile fits its kind (${a.asset_kind}): ${ctx.assetId}`);
      }
      await sql`UPDATE assets SET primary_profile_id = ${profileId}, updated_at = NOW() WHERE id = ${ctx.assetId} AND primary_profile_id IS NULL`;
    }
    // Later stages read the run's profile (indicator design needs one); each stage reloads the context from the row.
    if (!ctx.profileId) {
      await sql`
        UPDATE research_runs SET profile_id = ${profileId},
          profile_version = COALESCE(profile_version, (SELECT version FROM research_profiles WHERE id = ${profileId})), updated_at = NOW()
        WHERE id = ${ctx.runId} AND profile_id IS NULL`;
    }

    // Ensure run-scoped profile assignment exists
    const existing = await sql`
      SELECT id FROM asset_profile_assignments
      WHERE asset_id = ${ctx.assetId}
        AND (research_run_id = ${ctx.runId} OR research_run_id IS NULL)
        AND status = 'active'
      LIMIT 1
    `;
    if (existing.length === 0) {
      await sql`
        INSERT INTO asset_profile_assignments (
          asset_id, research_run_id, profile_id, assignment_reason,
          assigned_by, confidence, status
        ) VALUES (
          ${ctx.assetId}, ${ctx.runId}, ${profileId},
          'Run-scoped assignment from asset-identity stage',
          'system-v3-identity', '1.0', 'active'
        )
      `;
    }
    return { status: "success", resolvedProfileId: profileId };
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = pipelineSql();
    const existing = await sql`
      SELECT id FROM asset_profile_assignments
      WHERE asset_id = ${ctx.assetId}
        AND (research_run_id = ${ctx.runId} OR research_run_id IS NULL)
        AND status = 'active'
      LIMIT 1
    `;
    const errors: string[] = [];
    if (existing.length === 0) {
      errors.push("No active profile assignment found for asset");
    }
    return makeValidationResult(errors);
  }
};
