import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { OPERATING_MODEL_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const operatingModelHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "operating_model",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "forecast-analyst:operating-model";
      const upstreamRows = await sql`
        SELECT artifact_type, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('historical_record', 'historical_diagnosis', 'segment_model', 'business_process_map')
          AND status IN ('validated', 'accepted')
      `;
      const upstream = Object.fromEntries(upstreamRows.map((row) => [String(row.artifact_type), row.content_json])) as Record<string, any>;
      const history = Array.isArray(upstream.historical_record?.observations)
        ? upstream.historical_record.observations as Array<Record<string, any>> : [];
      const historyByMetric = new Map<string, Array<Record<string, any>>>();
      for (const observation of history) {
        const key = String(observation.metric_key || "");
        if (!key || observation.value_numeric == null) continue;
        historyByMetric.set(key, [...(historyByMetric.get(key) || []), observation]);
      }
      const recentHistory = Object.fromEntries([...historyByMetric].map(([key, rows]) => [key,
        rows.sort((a, b) => (a.fiscal_year * 10 + a.fiscal_quarter) - (b.fiscal_year * 10 + b.fiscal_quarter))
          .slice(-6).map((row) => ({ period: `${row.fiscal_year}Q${row.fiscal_quarter}`, value: row.value_numeric, unit: row.unit, source_document_id: row.source_document_id }))
      ]));
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["operating_model_structure", "driver_tree_specification", "driver_tree", "top_down_bottom_up_reconciliation", "reinvestment_model"],
        required_scenario_drivers: ctx.composedProfile?.required_scenario_drivers || [],
        recent_reported_history: recentHistory,
        historical_diagnoses: (upstream.historical_diagnosis?.diagnoses || []).map((item: any) => ({
          metric_key: item.metric_key, trend: item.trend, observation_count: item.observation_count, confidence: item.confidence,
        })),
        segments: upstream.segment_model?.segments || [],
        process_nodes: (upstream.business_process_map?.process_nodes || []).map((item: any) => ({
          process_node: item.process_node, financial_line_affected: item.financial_line_affected, main_constraint: item.main_constraint,
        })),
        output_contract: "operating_model",
        output_schema: OPERATING_MODEL_CONTRACT.schema,
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: OPERATING_MODEL_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Construct a driver-based forecast tree structure, mapping historical inputs to future drivers.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          "Cover each reportable segment and reconcile their forecast revenue and operating income to consolidated totals.",
          "Use recent_reported_history as the quantitative anchor. Label units and forecast horizon in optional explanatory fields.",
          "Set bottom_up_forecast_total to the sum of segment forecast revenue. Independently derive top_down_forecast_total from sourced market and customer constraints when available.",
          "If TAM or customer budget cannot be supported, set the unavailable limit and top_down_forecast_total to null, mark reconciliation_status as blocked_source_gap, and list the gap. Never use zero as a missing-data placeholder or invent a bound.",
          "Make reinvestment_model reflect the stated capex, working capital, and balance sheet assumptions; use source_gaps for unsupported amounts.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "operating_model", taskKey,
        taskType: "operating_model", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: OPERATING_MODEL_CONTRACT,
      });
      const reconciliation = output.top_down_bottom_up_reconciliation;
      if (reconciliation && (Number(reconciliation.tam_limit) <= 0 || Number(reconciliation.customer_budget_limit) <= 0)) {
        if (Number(reconciliation.tam_limit) <= 0) reconciliation.tam_limit = null;
        if (Number(reconciliation.customer_budget_limit) <= 0) reconciliation.customer_budget_limit = null;
        reconciliation.top_down_forecast_total = null;
        reconciliation.reconciliation_status = "blocked_source_gap";
      }

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = OPERATING_MODEL_CONTRACT.requiredKeys;
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
};
