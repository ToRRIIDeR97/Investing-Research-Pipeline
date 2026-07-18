import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { callV3Agent, v3ExactJsonPrompt } from "../../v3-context";
import { createArtifactRepository } from "../../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const VALUATION_OUTPUT_KEYS = [
  "applicable_methods",
  "not_applicable_methods",
  "valuation_signals",
  "scenarios",
  "method_proposals",
  "assumptions",
  "sensitivity_notes",
  "method_risks",
  "source_gaps",
];

export const assetValuationHandler: V3StageHandler<unknown> = {
  stageKey: "asset_valuation",
  async execute(ctx: V3RunContext): Promise<unknown> {
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

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "valuation-analyst",
        requiredKeys: VALUATION_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Execute valuation lenses appropriate to the asset profile.",
          "Provide per-share valuation targets and probabilistic scenarios.",
        ],
      });

      const output = await callV3Agent<Record<string, any>>({
        sql, ctx, stageKey: "asset_valuation", taskKey,
        taskType: "asset_valuation", agentName: "valuation-analyst", modelTier: "mid",
        packet, promptFactory,
      });

      // 4. Persist to valuation_signals table
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

      // 5. Persist to scenarios table
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

      // Persist valuation artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = ["valuation_scenario_set", "reverse_valuation", "annual_price_target_path"];
      for (const k of subKeys) {
        if (output[k]) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "accepted",
            content_json: output[k],
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "v3",
            created_by: "system-v3",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const sigs = await sql`
        SELECT COUNT(*) as cnt FROM valuation_signals WHERE research_run_id = ${ctx.runId}
      `;
      const scens = await sql`
        SELECT COUNT(*) as cnt FROM scenarios WHERE research_run_id = ${ctx.runId}
      `;
      const errors: string[] = [];
      if (Number(sigs[0].cnt) === 0) {
        errors.push("No valuation signals generated for this run");
      }
      if (Number(scens[0].cnt) === 0) {
        errors.push("No scenarios generated for this run");
      }
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
