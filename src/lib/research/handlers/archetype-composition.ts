import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { persistV3Composition } from "../run-context";
import { validateCompositionForRun } from "../archetypes/compose";
import postgres from "postgres";

export function archetypesForProfile(profileKey: string | null): string[] {
  return profileKey === "financials"
    ? ["operating_company_core", "bank", "lender", "payments_network"]
    : ["operating_company_core"];
}

export const archetypeCompositionHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "archetype_composition",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      let archetypes: string[] = [];
      let overlays: string[] = [];

      // Determine archetypes and overlays from the profile key, or run metadata if provided
      if (ctx.archetypeKeys && ctx.archetypeKeys.length > 0) {
        archetypes = ctx.profileKey === "financials"
          ? ["operating_company_core", ...ctx.archetypeKeys.filter((key) => key !== "marketplace" && key !== "operating_company_core")]
          : ctx.archetypeKeys;
        overlays = ctx.overlayKeys || [];
      } else {
        archetypes = archetypesForProfile(ctx.profileKey);
      }

      const compositionErrors = validateCompositionForRun(archetypes, overlays);
      if (compositionErrors.length) throw new Error(compositionErrors.map((error) => error.message).join("; "));

      await persistV3Composition(sql, ctx.runId, archetypes, overlays);
      return { status: "success", archetypes, overlays };
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
      console.log("[archetype.validate] metadata:", JSON.stringify(metadata));
      const archetypes = Array.isArray(metadata?.v3_archetypes) ? metadata.v3_archetypes : [];
      const errors = validateCompositionForRun(archetypes, Array.isArray(metadata?.v3_overlays) ? metadata.v3_overlays : [])
        .map((error) => error.message);
      if (!Array.isArray(archetypes) || archetypes.length === 0) {
        errors.push("No archetypes composed/persisted for this run");
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
