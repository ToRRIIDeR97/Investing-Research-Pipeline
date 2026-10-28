import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { persistV3Composition } from "../run-context";
import postgres from "postgres";
import { classificationArchetypes } from "../framing";
import { validateCompositionForRun } from "../archetypes/compose";

export const archetypeCompositionHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "archetype_composition",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      let archetypes: string[] = [];
      let overlays: string[] = [];

      // Archetypes named at run creation win. Otherwise the asset's stored sector and industry pick them
      // (classificationArchetypes); the framing call may add more, and the reviewer can change them at the plan gate.
      const [run] = await sql`SELECT metadata_json->>'v3_archetypes_source' AS source FROM research_runs WHERE id = ${ctx.runId}`;
      let source = String(run?.source || "request");
      if (ctx.archetypeKeys && ctx.archetypeKeys.length > 0) {
        archetypes = ctx.archetypeKeys;
        overlays = ctx.overlayKeys || [];
      } else {
        const [asset] = await sql`SELECT sector, industry, asset_kind AS "assetKind" FROM assets WHERE id = ${ctx.assetId}`;
        archetypes = classificationArchetypes(ctx.profileKey, asset || {});
        overlays = [];
        source = "classification";
      }

      await persistV3Composition(sql, ctx.runId, archetypes, overlays);
      await sql`UPDATE research_runs SET metadata_json = coalesce(metadata_json, '{}'::jsonb) || ${sql.json({ v3_archetypes_source: source })} WHERE id = ${ctx.runId}`;
      return { status: "success", archetypes, overlays, source };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const runs = await sql`
        SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}
      `;
      const metadata = runs[0]?.metadata_json as Record<string, any>;
      const archetypes = Array.isArray(metadata?.v3_archetypes) ? metadata.v3_archetypes : [];
      const errors: string[] = [];
      if (!Array.isArray(archetypes) || archetypes.length === 0) {
        errors.push("No archetypes composed/persisted for this run");
      } else {
        // A set that does not compose leaves every later stage without a profile; fail here instead.
        const overlays = Array.isArray(metadata?.v3_overlays) ? metadata.v3_overlays : [];
        for (const error of validateCompositionForRun(archetypes.map(String), overlays.map(String))) errors.push(error.message);
      }
      return makeValidationResult(errors);
    } catch (e: any) {
      console.error("[archetype.validate] error:", e.message);
      return makeValidationResult([e.message]);
    } finally {
      await sql.end();
    }
  }
};
