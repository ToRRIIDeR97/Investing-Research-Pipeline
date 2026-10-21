import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { MOAT_CONTRACT } from "../stage-contracts";
import { attackTargetErrors, capMoatClassifications } from "../moat/validation";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const moatAnalysisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "moat_analysis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "moat-analyst:assessment";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["moat_durability", "competitive_advantage_sources"],
        output_contract: "moat_analysis",
        output_schema: MOAT_CONTRACT.schema,
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: MOAT_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Test each claimed moat source (network effects, switching costs, cost advantage, intangibles, efficient scale) against a specific KPI and its trend: retention or churn, pricing versus peers, unit cost versus competitors, share stability, or return on incremental capital above the cost of capital.",
          "Explain how each advantage shows up in margins or returns, and state the counter-evidence: competitor entry, price cuts, rising acquisition cost, falling take rate or retention. A source without KPI support is unproven; no demonstrated moat is a valid conclusion.",
          "Classify each moat as unproven, weak, moderate, strong or exceptional and score the six scores 0-5. Cite evidence_claims ids in supporting_claim_ids and the computed data you tested it against in artifact_paths: financial_analytics paths for the multi-year record (margins, returns, segment economics) and peer_benchmark paths for competitor growth and margins. Strong or exceptional needs both; code caps it at moderate otherwise.",
          "Build the attack table from the named attackers, including competitors the filing passages name (for example in risk factors) and research_framing.named_peers. Each attack names the claimed_moat it tests in targets_moat and says whether the moat survives fully, partially or not at all, with competitor numbers from peer_benchmark where stored.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "moat_analysis", taskKey,
        taskType: "moat_analysis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: { ...MOAT_CONTRACT, validate(value) {
          const errors = MOAT_CONTRACT.validate?.(value) || [];
          if (errors.length) return errors;
          const v = value as Record<string, any>;
          return attackTargetErrors(v.moat_assessment, v.moat_attack_matrix).map(message => ({ path: "moat_attack_matrix.attacks", message }));
        } },
      });
      if (output.moat_assessment) output.moat_assessment = capMoatClassifications(output.moat_assessment);

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = MOAT_CONTRACT.requiredKeys;
      for (const k of subKeys) {
        if (output[k]) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "validated",
            content_json: output[k],
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
};
