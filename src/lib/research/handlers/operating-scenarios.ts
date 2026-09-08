import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { OPERATING_SCENARIOS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { validateOperatingScenarioSet } from "../forecast/validation";

export const operatingScenariosHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "operating_scenarios",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const upstreamRows = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('operating_model', 'driver_tree', 'business_process_map', 'historical_diagnosis', 'moat_assessment', 'no_moat_counterfactual')
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
        required_modules: ["scenario_specifications", "bear_base_bull_ranges", "operating_scenarios"],
        output_contract: "operating_scenarios",
        output_schema: OPERATING_SCENARIOS_CONTRACT.schema,
        upstream_artifacts: upstream,
      };
      const taskKey = `forecast-analyst:scenarios:v3:${createHash("sha256")
        .update(JSON.stringify(packet))
        .digest("hex")
        .slice(0, 12)}`;

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: OPERATING_SCENARIOS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Establish probabilistic base, bull, and bear scenario assumptions for all forecast drivers.",
          "Follow output_schema exactly and return exactly one bear, one base, and one bull scenario.",
          "Use upstream_artifacts.operating_model as the base-case starting forecast: its consolidated revenue must equal the earliest-year base scenario total revenue, and its segment names must remain consistent throughout.",
          "Vary the documented business-process constraints and moat failure indicators across bear/base/bull; the bear case must reconcile to upstream_artifacts.no_moat_counterfactual when that artifact exists.",
          "resulting_financial_statements_json must include numeric total_revenue and net_income for every scenario, with both values strictly increasing from bear to base to bull.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "operating_scenarios", taskKey,
        taskType: "operating_scenarios", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: OPERATING_SCENARIOS_CONTRACT,
        validateStructured: (value) => validateOperatingScenarioSet(
          (value as Record<string, unknown>).operating_scenario_set
        ).errors.map((message) => ({ path: "operating_scenario_set", message })),
      });

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = OPERATING_SCENARIOS_CONTRACT.requiredKeys;
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
      const artifactKeys = OPERATING_SCENARIOS_CONTRACT.requiredKeys;
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
