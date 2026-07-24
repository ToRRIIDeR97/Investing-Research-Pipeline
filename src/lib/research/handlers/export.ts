import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { generateReport } from "@/lib/export/report-generator";
import type { ResearchReportData } from "@/lib/export/report-generator";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";

export const exportHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "export",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      // Load accepted/validated artifacts for the run
      const artifacts = await sql`
        SELECT artifact_type, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type
      `;

      // Load asset info
      const [asset] = await sql`
        SELECT a.canonical_name, a.slug, a.asset_kind
        FROM assets a
        WHERE a.id = ${ctx.assetId}
        LIMIT 1
      `;

      // Build report data from artifacts — map content_json to typed report data
      const reportData: ResearchReportData = {
        runId: ctx.runId,
        asset: {
          canonical_name: asset?.canonical_name || ctx.assetName || "Unknown",
          slug: asset?.slug || ctx.assetSlug || "unknown",
          asset_kind: asset?.asset_kind || "equity",
        },
        isTestRun: process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1",
      };

      for (const art of artifacts) {
        const content = art.content_json as Record<string, unknown>;
        switch (art.artifact_type) {
          case "company_genesis":
            reportData.genesis = {
              strategic_identity: (content as any).company_genesis,
              founder_profile: (content as any).founder_profile,
              origin_history: (content as any).strategic_history_timeline,
            };
            break;
          case "historical_diagnosis":
            reportData.diagnosis = {
              diagnoses: [(content as any).historical_diagnosis].filter(Boolean),
            } as any;
            break;
          case "segment_model":
            // business_process_analysis sub-artifacts accumulated as we iterate
            if (!reportData.business_process) reportData.business_process = {};
            const bp = reportData.business_process as any;
            if (!bp.segments) bp.segments = [];
            bp.segments.push({ segment_name: art.artifact_type, revenue_model: "N/A", customer_or_end_user: "N/A" });
            break;
          case "customer_decision_map":
            if (!reportData.business_process) reportData.business_process = {};
            const bp2 = reportData.business_process as any;
            if (!bp2.customer_decisions) bp2.customer_decisions = [];
            bp2.customer_decisions.push({ decision_maker: art.artifact_type, primary_need: "N/A" });
            break;
          case "business_process_map":
            if (!reportData.business_process) reportData.business_process = {};
            const bp3 = reportData.business_process as any;
            if (!bp3.process_maps) bp3.process_maps = [];
            bp3.process_maps.push({ process_name: art.artifact_type, bottleneck: "N/A" });
            break;
          case "moat_assessment":
            reportData.moat = {
              ...(reportData.moat || {}),
              strength: (content as any).moat_durability,
              durability: String((content as any).moat_score || "N/A"),
              no_moat_counterfactual: (content as any).no_moat_counterfactual,
            };
            break;
          case "moat_attack_matrix":
            reportData.moat = {
              ...(reportData.moat || {}),
              attacks: ((content as any).competitive_threats || []).map((t: any) => ({
                threat: t.name || String(t),
                severity: t.severity || "medium",
              })),
            };
            break;
          case "operating_model":
            reportData.forecast = {
              ...(reportData.forecast || {}),
              operating_model_summary: JSON.stringify(content).slice(0, 500),
            };
            break;
          case "operating_scenario_set": {
            const osc = content as any;
            reportData.forecast = {
              ...(reportData.forecast || {}),
              scenarios: osc.scenarios || osc.scenario_probabilities
                ? Object.entries(osc.scenario_probabilities || osc.scenarios || {}).map(
                    ([name, prob]: [string, any]) => ({
                      scenario_name: name,
                      probability: typeof prob === 'number' ? prob : prob?.probability || 0.5,
                      revenue_growth: 0,
                    })
                  )
                : [],
            };
            break;
          }
          case "valuation_scenario_set": {
            const v = content as any;
            reportData.valuation = {
              ...(reportData.valuation || {}),
              terminal_year: v.terminal_year || 2030,
              scenarios: v.scenarios?.map((s: any) => ({
                scenario_type: s.scenario_type || "base",
                terminal_anchor: s.terminal_anchor || 0,
              })) || [],
            };
            break;
          }
          case "reverse_valuation":
            reportData.valuation = {
              ...(reportData.valuation || {}),
              terminal_year: (reportData.valuation?.terminal_year || 2030),
              reverse_valuations: (content as any).reverse_valuations || [],
            };
            break;
          case "annual_price_target_path":
            reportData.valuation = {
              ...(reportData.valuation || {}),
              terminal_year: (reportData.valuation?.terminal_year || 2030),
              price_target_paths: (content as any).price_target_paths || (content as any).annual_price_targets || [],
            };
            break;
          case "investment_thesis":
            reportData.decision = {
              ...(reportData.decision || {}),
              thesis_statement: (content as any).thesis || (content as any).investment_thesis || String(content),
            };
            break;
          case "risk_register":
            reportData.decision = {
              ...(reportData.decision || {}),
              risks: ((content as any).risks || (content as any).items || []).map((r: any) => ({
                risk_name: r.name || String(r),
                severity: r.severity || 5,
                causal_mechanism: r.causal_mechanism || "",
              })),
            };
            break;
          case "catalyst_register":
            reportData.decision = {
              ...(reportData.decision || {}),
              catalysts: ((content as any).catalysts || (content as any).items || []).map((c: any) => ({
                catalyst_name: c.name || String(c),
                probability: c.probability || 0.5,
                event_mechanism: c.mechanism || "",
              })),
            };
            break;
          case "decision_record":
            reportData.decision = {
              ...(reportData.decision || {}),
              decision_record: {
                decision: (content as any).conviction || (content as any).decision || "hold",
              },
            };
            break;
          case "backtest_review":
            reportData.backtest = content as ResearchReportData["backtest"];
            break;
        }
      }

      const result = await generateReport({
        runId: ctx.runId,
        data: reportData,
        generatedBy: "system-research-os",
      });

      // Keep the durable export index in sync with the report artifact. The
      // index is the compatibility/read-model surface used by workflow gates
      // and downstream package builders.
      await sql`
        INSERT INTO exports (
          asset_id, research_run_id, export_type, template_version,
          storage_path, content_hash, generated_by, generated_at, metadata_json
        )
        SELECT
          ${ctx.assetId}, ${ctx.runId}, 'markdown_memo', '3.0.0',
          ${result.storagePath}, ${result.contentHash}, 'system-research-os', NOW(),
          ${JSON.stringify({ exportId: result.exportId, pipelineVersion: CURRENT_PIPELINE_VERSION })}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM exports
          WHERE research_run_id = ${ctx.runId} AND export_type = 'markdown_memo'
        )
      `;

      // Idempotent: only insert if no synthetic report exists for this run
      const existing = await sql`
        SELECT id FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'synthetic_report'
        LIMIT 1
      `;

      if (!existing[0]) {
        await sql`
          INSERT INTO research_artifacts (
            research_run_id, asset_id, artifact_type, scope_key,
            status, content_json, schema_version, validator_version,
            prompt_version, created_by
          ) VALUES (
            ${ctx.runId}, ${ctx.assetId}, 'synthetic_report',
            ${`${ctx.assetSlug}-synthetic-report`},
            'validated',
            ${sql.json({
              exportId: result.exportId,
              storagePath: result.storagePath,
              contentHash: result.contentHash,
              generatedAt: new Date().toISOString(),
              sections: 25,
            })},
            '3.0.0', '1.0.0', 'current', 'system-research-os'
          )
        `;
      }

      return {
        exported: true,
        exportId: result.exportId,
        storagePath: result.storagePath,
        contentHash: result.contentHash,
      };
    } finally {
      await sql.end();
    }
  },
  async validate(_ctx: ResearchRunContext, output: unknown): Promise<ValidationResult> {
    const out = output as Record<string, unknown> | undefined;
    const errors: string[] = [];
    if (!out?.exported) errors.push("Export did not complete");
    if (!out?.exportId) errors.push("No export ID generated");
    return makeValidationResult(errors);
  }
};
