import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { persistV3Composition } from "../../v3-context";
import postgres from "postgres";

export const archetypeCompositionHandler: V3StageHandler<unknown> = {
  stageKey: "archetype_composition",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      let archetypes: string[] = [];
      let overlays: string[] = [];

      // Determine archetypes and overlays from the profile key, or run metadata if provided
      if (ctx.archetypeKeys && ctx.archetypeKeys.length > 0) {
        archetypes = ctx.archetypeKeys;
        overlays = ctx.overlayKeys || [];
      } else {
        const profileKey = ctx.profileKey;
        if (profileKey === "financials") {
          archetypes = ["bank", "lender", "marketplace", "payments_network"];
          overlays = [];
        } else if (profileKey === "operating_company") {
          archetypes = [
            "operating_company_core",
            "marketplace",
            "payments_network",
            "lender",
            "logistics_network",
            "advertising_platform",
          ];
          overlays = ["emerging_market_multi_country"];
        } else {
          // Default to operating company core
          archetypes = ["operating_company_core"];
          overlays = [];
        }
      }

      await persistV3Composition(sql, ctx.runId, archetypes, overlays);
      return { status: "success", archetypes, overlays };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const runs = await sql`
        SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}
      `;
      const metadata = runs[0]?.metadata_json as Record<string, any>;
      const archetypes = metadata?.v3_archetypes || [];
      const errors: string[] = [];
      if (!Array.isArray(archetypes) || archetypes.length === 0) {
        errors.push("No archetypes composed/persisted for this run");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
