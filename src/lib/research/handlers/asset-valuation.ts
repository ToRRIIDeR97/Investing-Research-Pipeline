import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { VALUATION_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const assetValuationHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "asset_valuation",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "valuation-analyst:valuation";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_lenses: ctx.composedProfile?.valuation_methods.map((m: any) => m.method) || ["reverse_dcf"],
        valuation_method_protocol: {
          required_model_keys: ["driver_based_dcf"],
        },
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "valuation-analyst",
        requiredKeys: VALUATION_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Execute valuation lenses appropriate to the asset profile.",
          "Provide per-share valuation targets and probabilistic scenarios.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "asset_valuation", taskKey,
        taskType: "asset_valuation", agentName: "valuation-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: VALUATION_CONTRACT,
      });

      // Persist to valuation_signals table
      const signals = Array.isArray(output.valuation_signals) ? output.valuation_signals : [];
      for (const sig of signals) {
        await sql`
          INSERT INTO valuation_signals (
            asset_id, research_run_id, profile_id, signal_key, signal_name, lens_family,
            current_value_text, comparison_range_json, signal, cheapness_score, confidence, review_status
          ) VALUES (
            ${ctx.assetId}, ${ctx.runId}, ${ctx.profileId}, ${sig.signal_key}, ${sig.signal_name}, ${sig.lens_family},
            ${sig.current_value_text || null}, ${sql.json(sig.comparison_range_json || {})},
            ${sig.signal}, ${sig.cheapness_score || null}, ${sig.confidence || null}, 'accepted'
          )
        `;
      }

      // Persist to scenarios table
      const scens = Array.isArray(output.scenarios) ? output.scenarios : [];
      for (const scen of scens) {
        await sql`
          INSERT INTO scenarios (
            asset_id, research_run_id, scenario_name, scenario_type, value_anchor,
            assumptions_json, confidence, review_status
          ) VALUES (
            ${ctx.assetId}, ${ctx.runId}, ${scen.scenario_name}, ${scen.scenario_type}, ${scen.value_anchor || null},
            ${sql.json(scen.assumptions_json || {})}, ${scen.confidence || null}, 'accepted'
          )
        `;
      }

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = VALUATION_CONTRACT.requiredKeys;
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
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, _output: unknown): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const errors: string[] = [];
      const artifactKeys = VALUATION_CONTRACT.requiredKeys;
      for (const k of artifactKeys) {
        const rows = await sql`
          SELECT COUNT(*) as cnt FROM research_artifacts
          WHERE research_run_id = ${ctx.runId}
            AND artifact_type = ${k}
            AND status IN ('validated', 'accepted')
        `;
        if (Number(rows[0].cnt) === 0) {
          errors.push(`Missing required artifact: ${k}`);
        }
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
