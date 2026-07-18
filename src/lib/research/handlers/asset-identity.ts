import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import postgres from "postgres";

export const assetIdentityHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "asset_identity",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const assetRows = await sql`
        SELECT primary_profile_id FROM assets WHERE id = ${ctx.assetId}
      `;
      if (assetRows.length === 0) {
        throw new Error(`Asset not found: ${ctx.assetId}`);
      }
      const profileId = assetRows[0].primary_profile_id;
      if (!profileId) {
        throw new Error(`Asset has no primary profile: ${ctx.assetId}`);
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
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
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
    } finally {
      await sql.end();
    }
  }
};
