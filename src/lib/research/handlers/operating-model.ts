import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgentArtifacts, exactJsonPrompt } from "../run-context";
import { OPERATING_MODEL_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import {
  validateDriverTree,
  validateOperatingModel,
  validateTopDownBottomUpReconciliation,
} from "../forecast/validation";

export const operatingModelHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "operating_model",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const upstreamRows = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('segment_model', 'business_process_map', 'historical_record', 'historical_diagnosis', 'moat_assessment', 'no_moat_counterfactual')
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type
      `;
      const upstream = Object.fromEntries(
        upstreamRows.map((row) => [String(row.artifact_type), row.content_json])
      );
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: [
          "operating_model_structure",
          "driver_tree_specification",
          "driver_tree",
          "top_down_bottom_up_reconciliation",
          "reinvestment_economics",
        ],
        output_contract: "operating_model",
        output_schema: OPERATING_MODEL_CONTRACT.schema,
        upstream_artifacts: upstream,
      };
      const taskKey = `forecast-analyst:operating-model:v3:${createHash("sha256")
        .update(JSON.stringify(packet))
        .digest("hex")
        .slice(0, 12)}`;

      const artifactRules: Record<string, string[]> = {
        driver_tree: [
          "Construct a driver-based forecast tree from historical inputs. Revenue formula_decomposition must be an operational equation, not CAGR or a growth-rate restatement. For financial services use measurable members, products, balances, volumes, yield or take rate.",
          "Copy process_node_key exactly from upstream_artifacts.business_process_map.process_nodes[].process_node; do not invent aliases.",
          "Calibrate to historical_record and historical_diagnosis, and make moat assumptions explicit in driver failure conditions.",
        ],
        operating_model: [
          "Use the accepted driver_tree and historical_record to forecast every material segment in upstream_artifacts.segment_model. Reconcile segment revenue and operating income exactly to consolidated totals.",
          "Use differentiated forecasts for economically distinct segments, never identical balancing values. Make no-moat assumptions explicit.",
        ],
        reinvestment_model: [
          "Provide explicit annual capex and working-capital forecasts consistent with the accepted operating_model and driver_tree, calibrated to historical_record.",
        ],
        top_down_bottom_up_reconciliation: [
          "Reconcile the accepted operating_model and reinvestment_model with a defensible top-down market and customer-budget ceiling. Disclose differences without rewriting accepted forecasts.",
        ],
      };
      const promptFactory = (p: Record<string, unknown>, artifactKey: string) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: [artifactKey],
        packet: p,
        extraRules: [
          "Produce only the assigned artifact. Treat accepted_artifacts as checked dependencies, not outputs to reproduce.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          ...artifactRules[artifactKey],
        ],
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const validators: Record<string, (value: unknown) => Pick<ValidationResult, 'valid' | 'errors' | 'warnings'>> = {
        driver_tree: validateDriverTree, operating_model: validateOperatingModel,
        top_down_bottom_up_reconciliation: validateTopDownBottomUpReconciliation,
      };
      const output = await callResearchAgentArtifacts({
        sql, ctx, stageKey: 'operating_model', taskKeyPrefix: taskKey,
        taskType: 'operating_model', agentName: 'asset-analyst', packet, promptFactory,
        outputFormat: OPERATING_MODEL_CONTRACT,
        artifactWaves: [['driver_tree'], ['operating_model'], ['reinvestment_model'], ['top_down_bottom_up_reconciliation']],
        validateArtifact: (key, value) => validators[key]?.(value) || makeValidationResult(),
        onArtifact: async (k, value) => {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "validated",
            content_json: value,
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "current",
            created_by: "system-research-os",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        },
      });

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, _output: unknown): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const errors: string[] = [];
      const artifactKeys = OPERATING_MODEL_CONTRACT.requiredKeys;
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
