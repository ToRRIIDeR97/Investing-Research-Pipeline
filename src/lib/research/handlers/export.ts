import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { generateReport } from "@/lib/export/report-generator";
import type { ResearchReportData } from "@/lib/export/report-generator";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { getReportState, loadReportInputs, saveReportArtifact } from "../reporting/store";
import { assertReportApproval } from "../reporting/report";
import { withheldValuationReason } from "../valuation/contracts";

export const exportHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "export",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const reportState = await getReportState(sql, ctx.runId);
      if (reportState.required) {
        if (!reportState.document) throw new Error("The reviewed report is missing");
        const inputs = await loadReportInputs(sql, ctx.runId, reportState.cutoff);
        assertReportApproval(reportState.document, reportState.approval, inputs.input_hash);
      }
      // Load accepted/validated artifacts for the run
      const artifacts = await sql`
        SELECT DISTINCT ON (artifact_type, scope_key) artifact_type, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
      `;

      // Load asset info
      const [asset] = await sql`
        SELECT a.canonical_name, a.slug, a.asset_kind
        FROM assets a
        WHERE a.id = ${ctx.assetId}
        LIMIT 1
      `;
      const [reviewDecision] = await sql`
        SELECT status, reviewed_by FROM review_decisions
        WHERE research_run_id = ${ctx.runId}
        ORDER BY reviewed_at DESC LIMIT 1
      `;
      const roleCoverage = await sql`
        SELECT source_role,
               COUNT(*) FILTER (WHERE coverage_status = 'covered') AS covered,
               COUNT(*) FILTER (WHERE coverage_status = 'gap') AS gaps
        FROM source_role_coverage
        WHERE research_run_id = ${ctx.runId}
        GROUP BY source_role ORDER BY source_role
      `;

      // Build report data from artifacts — map content_json to typed report data
      const reportData: ResearchReportData = {
        report_document: reportState.required ? reportState.document! : undefined,
        runId: ctx.runId,
        asset: {
          canonical_name: asset?.canonical_name || ctx.assetName || "Unknown",
          slug: asset?.slug || ctx.assetSlug || "unknown",
          asset_kind: asset?.asset_kind || "equity",
        },
        isTestRun: process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1",
        source_roles: roleCoverage.map((row) => ({ role: String(row.source_role), covered: Number(row.covered), gaps: Number(row.gaps) })),
      };

      for (const art of artifacts) {
        const content = art.content_json as Record<string, unknown>;
        switch (art.artifact_type) {
          case "company_genesis":
            reportData.genesis = {
              ...(reportData.genesis || {}),
              strategic_identity: String(content.original_product || "") + " " + String((content as any).present_day_implications?.[0] || ""),
            };
            break;
          case "founder_profile":
            reportData.genesis = { ...(reportData.genesis || {}), founder_profile: String(content.background_summary || "") };
            break;
          case "strategic_history_timeline":
            reportData.genesis = {
              ...(reportData.genesis || {}),
              origin_history: Array.isArray(content.events)
                ? content.events.map((event: any) => `${event.date_or_period}: ${event.event}`).join("; ")
                : "",
            };
            break;
          case "historical_record": {
            const coverage = content.coverage as any;
            const required = new Set((coverage?.cells || []).filter((cell: any) => cell.present)
              .map((cell: any) => `${cell.metric_key}:${cell.fiscal_year}:${cell.fiscal_quarter}`));
            const observations = Array.isArray(content.observations) ? content.observations : [];
            reportData.historical_record = observations
              .filter((row: any) => required.has(`${row.metric_key}:${row.fiscal_year}:${row.fiscal_quarter}`))
              .map((row: any) => ({
                fiscal_year: Number(row.fiscal_year), fiscal_quarter: `Q${row.fiscal_quarter}`,
                metric_key: String(row.metric_key), value_numeric: Number(row.value_numeric), unit: String(row.unit || ""),
              }))
              .sort((a: any, b: any) => a.fiscal_year - b.fiscal_year || a.fiscal_quarter.localeCompare(b.fiscal_quarter) || a.metric_key.localeCompare(b.metric_key));
            reportData.historical_coverage = coverage ? { present: Number(coverage.quarters_present), required: Number(coverage.quarters_required) } : undefined;
            break;
          }
          case "historical_diagnosis":
            reportData.diagnosis = {
              diagnoses: Array.isArray(content.diagnoses) ? content.diagnoses.map((row: any) => ({
                metric_key: row.metric_key, diagnosis_type: row.trend,
                magnitude: row.inflection_z_score, explanation: row.forecast_implication,
              })) : [],
            };
            break;
          case "segment_model":
            reportData.business_process = { ...(reportData.business_process || {}), segments: Array.isArray(content.segments) ? content.segments as any : [] };
            break;
          case "customer_decision_map":
            reportData.business_process = { ...(reportData.business_process || {}), customer_decisions: Array.isArray(content.customer_groups)
              ? content.customer_groups.map((row: any) => ({ decision_maker: row.customer_group, primary_need: row.problem_initiating_demand })) : [] };
            break;
          case "business_process_map":
            reportData.business_process = { ...(reportData.business_process || {}), process_maps: Array.isArray(content.process_nodes)
              ? content.process_nodes.map((row: any) => ({ process_name: row.process_node, bottleneck: row.main_constraint })) : [] };
            break;
          case "competitive_response_matrix":
            reportData.competitive_responses = Array.isArray(content.competitors)
              ? content.competitors.flatMap((competitor: any) => (competitor.response_scenarios || []).map((scenario: any) =>
                `${competitor.competitor_name}: ${scenario.threat_description}. ${scenario.response_mechanism}. Expected effect: ${scenario.financial_impact}.`))
              : [];
            break;
          case "moat_assessment":
            reportData.moat = {
              ...(reportData.moat || {}),
              strength: Array.isArray(content.assessments) ? content.assessments.map((row: any) => `${row.claimed_moat}: ${row.current_strength}`).join("; ") : "",
              durability: Array.isArray(content.assessments) ? content.assessments.map((row: any) => `${row.moat_source}: ${row.durability}`).join("; ") : "",
            };
            break;
          case "moat_attack_matrix":
            reportData.moat = {
              ...(reportData.moat || {}),
              attacks: ((content as any).attacks || []).map((t: any) => ({
                threat: t.primary_attacker,
                mechanism: t.attack_mechanism,
              })),
            };
            break;
          case "no_moat_counterfactual":
            reportData.moat = { ...(reportData.moat || {}), no_moat_counterfactual: String(content.changed_economics_description || "") };
            break;
          case "operating_model":
            reportData.forecast = {
              ...(reportData.forecast || {}),
              operating_model_summary: `Next-fiscal-year forecast: revenue ${content.consolidated_revenue} and operating income ${content.consolidated_operating_income} ${content.units}. ${content.revenue_anchor || ""}`,
            };
            break;
          case "top_down_bottom_up_reconciliation":
            reportData.reconciliation = `${content.bottom_up_method} Bottom-up revenue: ${content.bottom_up_forecast_total} ${content.units}. Status: ${content.reconciliation_status}. ${Array.isArray(content.source_gaps) ? content.source_gaps.join(" ") : ""}`;
            break;
          case "reinvestment_model":
            reportData.reinvestment = `${content.balance_sheet_assumption} ${content.working_capital_basis} ${Array.isArray(content.source_gaps) ? content.source_gaps.join(" ") : ""}`;
            break;
          case "operating_scenario_set": {
            const osc = content as any;
            const baseRevenue = Number(osc.scenarios?.find((scenario: any) => scenario.scenario_type === "base")?.resulting_financial_statements_json?.consolidated_revenue);
            reportData.forecast = {
              ...(reportData.forecast || {}),
              scenarios: Array.isArray(osc.scenarios) ? osc.scenarios.map((scenario: any) => ({
                scenario_name: scenario.scenario_type,
                probability: Number(osc[`probability_${scenario.scenario_type}`]),
                revenue_growth: Number(scenario.resulting_financial_statements_json?.consolidated_revenue) / baseRevenue - 1,
              })) : [],
            };
            break;
          }
          case "valuation_scenario_set": {
            const v = content as any;
            reportData.valuation = {
              ...(reportData.valuation || {}),
              terminal_year: v.terminal_year || 2030,
              scenarios: (["bear", "base", "bull"] as const).map((scenario_type) => ({
                scenario_type, terminal_anchor: Number(v[`terminal_anchor_${scenario_type}`]),
              })),
            };
            break;
          }
          case "annual_price_target_path":
            reportData.valuation = {
              ...(reportData.valuation || {}),
              terminal_year: (reportData.valuation?.terminal_year || 2030),
              price_target_paths: (content as any).price_target_path || [],
            };
            break;
          case "investment_thesis":
            reportData.decision = {
              ...(reportData.decision || {}),
              thesis_statement: String(content.thesis_statement || ""),
            };
            break;
          case "expected_return_matrix":
            reportData.decision = { ...(reportData.decision || {}), expected_return_matrix: content as any };
            break;
          case "risk_register":
            reportData.decision = {
              ...(reportData.decision || {}),
              risks: ((content as any).risks || (content as any).items || []).map((r: any) => ({
                risk_name: r.risk_name,
                severity: r.severity || 5,
                causal_mechanism: r.causal_mechanism || "",
              })),
            };
            break;
          case "catalyst_register":
            reportData.decision = {
              ...(reportData.decision || {}),
              catalysts: ((content as any).catalysts || (content as any).items || []).map((c: any) => ({
                catalyst_name: c.catalyst_name,
                probability: c.probability || 0.5,
                event_mechanism: c.event_mechanism || "",
              })),
            };
            break;
          case "thesis_breakers":
            reportData.decision = { ...(reportData.decision || {}), breakers: (content as any).breakers || [] };
            break;
          case "monitoring_dashboard":
            reportData.decision = { ...(reportData.decision || {}), monitoring: (content as any).items || [] };
            break;
          case "decision_record":
            reportData.decision = {
              ...(reportData.decision || {}),
              decision_record: {
                decision: String(content.decision || "pending"),
              },
            };
            break;
          case "reverse_valuation":
            reportData.valuation = { ...(reportData.valuation || { terminal_year: 2030 }), reverse_valuations: [{ method: String(content.method || ""), implied_growth: content.implied_growth == null ? null : Number(content.implied_growth) }] };
            break;
          case "backtest_review":
            reportData.backtest = content as ResearchReportData["backtest"];
            break;
          case "review_summary":
            reportData.review_summary = String(content);
            break;
          case "review_verdict":
            reportData.review_verdict = String(content);
            break;
          case "recommendations":
            reportData.limitations = Array.isArray(content) ? content.map((item: any) =>
              typeof item === "string" ? item : item?.action
                ? `${item.action}${item.rationale ? `: ${item.rationale}` : ""}`
                : JSON.stringify(item)) : [];
            break;
        }
      }
      // A withheld valuation has no anchors, paths or returns to print; the report states the reason.
      const withheldReason = withheldValuationReason(artifacts.find((art) => art.artifact_type === "valuation_scenario_set")?.content_json);
      if (withheldReason) {
        reportData.valuation = { terminal_year: reportData.valuation?.terminal_year || 2030, withheld_reason: withheldReason };
        if (reportData.decision) delete reportData.decision.expected_return_matrix;
      }
      if (reviewDecision) {
        reportData.decision = {
          ...(reportData.decision || {}),
          decision_record: { decision: String(reviewDecision.status), human_approved_by: String(reviewDecision.reviewed_by || "Unknown") },
        };
      }

      const result = await generateReport({
        runId: ctx.runId,
        data: reportData,
        generatedBy: "system-research-os",
      });

      // Keep the durable export index in sync with the report artifact. The
      // index is the compatibility/read-model surface used by workflow gates
      // and downstream package builders. Only the pipeline's own row is
      // touched: memos a user exported share the export type (#115).
      await sql`
        UPDATE exports SET storage_path = ${result.storagePath},
          content_hash = ${result.contentHash}, generated_at = NOW(),
          metadata_json = ${JSON.stringify({ exportId: result.exportId, pipelineVersion: CURRENT_PIPELINE_VERSION })}::jsonb
        WHERE research_run_id = ${ctx.runId} AND export_type = 'markdown_memo'
          AND generated_by = 'system-research-os'
      `;
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
            AND generated_by = 'system-research-os'
        )
      `;

      // A retried export supersedes the previous synthetic report.
      const reportArtifact = {
        exportId: result.exportId,
        storagePath: result.storagePath,
        contentHash: result.contentHash,
        generatedAt: new Date().toISOString(),
        sections: reportState.document?.sections.length ?? 25,
        reportHash: reportState.document?.content_hash ?? null,
        humanDecision: reviewDecision?.status ?? null,
      };
      await saveReportArtifact(sql, ctx, "synthetic_report", `${ctx.assetSlug}-synthetic-report`, reportArtifact);

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
