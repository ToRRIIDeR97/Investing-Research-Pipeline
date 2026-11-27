import type { ResearchRunContext, StageHandler } from "../run-context";
import { OPERATING_FORECAST_CONTRACT, OPERATING_MODEL_CONTRACT, OPERATING_RECONCILIATION_CONTRACT } from "../stage-contracts";
import { runSplitStage } from "./split-calls";
import { forecastHorizon, forecastYears, historyRatios, operatingModelFirstYear } from "../valuation/engine";
import { valuationFinancialInputs } from "../valuation/financial-inputs";
import { createArtifactRepository } from "../artifacts/repository";
import { pipelineDb, pipelineSql } from "@/db/pipeline-sql";

/**
 * Latest reported values per metric, oldest first: { unit, values: { period: value }, source_document_ids }. Annual
 * periods sort after the quarters of their year. A metric reported in more than one unit keeps one row per value.
 * Per-row document ids made SoFi's history 129 KB for 222 metrics; listing each metric's documents once halves it.
 */
export function recentByMetric(observations: Array<Record<string, any>>, limit: number) {
  const byMetric = new Map<string, Array<Record<string, any>>>();
  for (const observation of observations) {
    const key = String(observation.metric_key || "");
    if (!key || observation.value_numeric == null) continue;
    byMetric.set(key, [...(byMetric.get(key) || []), observation]);
  }
  const order = (row: Record<string, any>) => row.fiscal_year * 10 + (row.fiscal_quarter ?? 5);
  const period = (row: Record<string, any>) => row.fiscal_quarter == null ? `FY${row.fiscal_year}` : `${row.fiscal_year}Q${row.fiscal_quarter}`;
  return Object.fromEntries([...byMetric].map(([key, all]) => {
    const rows = all.sort((a, b) => order(a) - order(b)).slice(-limit);
    const sources = [...new Set(rows.map((row) => row.source_document_id).filter(Boolean))];
    const units = new Set(rows.map((row) => row.unit ?? null));
    const periods = new Set(rows.map(period));
    if (units.size > 1 || periods.size < rows.length)
      return [key, rows.map((row) => ({ period: period(row), value: row.value_numeric, unit: row.unit, source_document_id: row.source_document_id }))];
    return [key, { unit: rows[0].unit ?? null, values: Object.fromEntries(rows.map((row) => [period(row), row.value_numeric])), source_document_ids: sources }];
  }));
}

/**
 * Code-owned reconciliation fields: a non-positive TAM or customer budget is a missing bound (null), and
 * bottom_up_forecast_total is the segment revenue sum whenever every segment has revenue. The TAM check
 * runs on the result, both on the model's answer and on the stored artifact.
 */
export function normalizeReconciliation(output: Record<string, any>): Record<string, any> {
  const source = output?.top_down_bottom_up_reconciliation;
  if (!source || typeof source !== "object") return output;
  const reconciliation = { ...source };
  if (Number(reconciliation.tam_limit) <= 0 || Number(reconciliation.customer_budget_limit) <= 0) {
    if (Number(reconciliation.tam_limit) <= 0) reconciliation.tam_limit = null;
    if (Number(reconciliation.customer_budget_limit) <= 0) reconciliation.customer_budget_limit = null;
    reconciliation.top_down_forecast_total = null;
    reconciliation.reconciliation_status = "blocked_source_gap";
  }
  const segments = output?.operating_model?.segments;
  if (Array.isArray(segments) && segments.length && segments.every((segment: any) => typeof segment?.forecast_revenue === "number")) {
    reconciliation.bottom_up_forecast_total = segments.reduce((sum: number, segment: any) => sum + segment.forecast_revenue, 0);
  }
  return { ...output, top_down_bottom_up_reconciliation: reconciliation };
}

/**
 * The operating model forecasts the fiscal year after the latest reported one; scenarios and valuation take their
 * first forecast year from it. A consolidated revenue within 0.5% of the reported base year restates that year.
 */
export function forecastPeriodErrors(output: Record<string, any>, period: { fiscal_year: number; base_fiscal_year: number; base_revenue_millions: number | null }) {
  if (!(Number(period.base_revenue_millions) > 0)) return [];
  const first = operatingModelFirstYear(output?.operating_model, period.base_revenue_millions);
  if (!first || Math.abs(first.revenue / period.base_revenue_millions! - 1) >= 0.005) return [];
  return [{ path: "operating_model.consolidated_revenue", message: `consolidated_revenue repeats reported FY${period.base_fiscal_year} revenue; it must be the FY${period.fiscal_year} forecast.` }];
}

/** The first call: the driver tree and the forecast. */
export const OPERATING_FORECAST_RULES = [
  "Construct a driver-based forecast tree structure, mapping historical inputs to future drivers.",
  "Forecast each segment's revenue as price × volume and bridge operating margin from the base year to the forecast (gross margin, operating cost lines, mix, operating leverage), naming the driver of each step and why it moves.",
  "Cover each reportable segment and reconcile their forecast revenue and operating income to consolidated totals.",
  "Every forecast figure (consolidated_revenue, consolidated_operating_income and each segment's forecast) is for fiscal year forecast_period.fiscal_year, the year after the latest reported year. Never restate a reported year's figures as the forecast.",
  "Use reported_segment_history (XBRL segment members such as meta:FamilyOfAppsMember) as the anchor for segment revenue and operating income; values are in the reported unit.",
  "Use recent_reported_history as the quantitative anchor. Label units and forecast horizon in optional explanatory fields.",
];

/** The second call: the reconciliation and the reinvestment model, against the accepted forecast. */
export const OPERATING_RECONCILIATION_RULES = [
  "Set bottom_up_forecast_total to the sum of the segment forecast revenue in accepted_artifacts.operating_model. Independently derive top_down_forecast_total from sourced market and customer constraints when available.",
  "If TAM or customer budget cannot be supported, set the unavailable limit and top_down_forecast_total to null, mark reconciliation_status as blocked_source_gap, and list the gap. Never use zero as a missing-data placeholder or invent a bound.",
  "Tie reinvestment to growth: compare incremental operating income with incremental invested capital (return on incremental capital) against the historical rate, and explain any gap.",
  "Make reinvestment_model reflect the stated capex, working capital, and balance sheet assumptions; use source_gaps for unsupported amounts.",
];

export const operatingModelHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "operating_model",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = pipelineSql();
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
    const recentHistory = recentByMetric(history.filter((observation) => !observation.segment), 6);
    // Reported segment revenue and operating income from the filings' segment note, keyed by segment member.
    const segmentRows = history.filter((observation) => observation.segment && observation.metadata_json?.statement === "segment");
    const reportedSegmentHistory = Object.fromEntries([...new Set(segmentRows.map((row) => String(row.segment)))].map((segment) =>
      [segment, recentByMetric(segmentRows.filter((row) => row.segment === segment), 8)]));
    // Code fixes the forecast period: the year after the latest captured fiscal year, as operating scenarios use.
    const [statementSet] = await sql`
      SELECT content_json->'observations' AS observations, content_json ? 'quarter_coverage' AS foreign_issuer FROM research_artifacts
      WHERE research_run_id = ${ctx.runId} AND artifact_type = 'financial_statement_set' AND status IN ('validated', 'accepted')
      ORDER BY created_at DESC LIMIT 1
    `;
    const cutoff = ctx.marketDataCutoffAt || ctx.cutoffAt;
    const ratios = historyRatios(valuationFinancialInputs({
      statementObservations: Array.isArray(statementSet?.observations) ? statementSet.observations : [], cutoff,
      foreignIssuer: statementSet?.foreign_issuer === true,
    }));
    const baseYear = ratios.base_year?.fiscal_year ?? cutoff.getUTCFullYear() - 1;
    const forecastPeriod = { fiscal_year: forecastHorizon(baseYear, forecastYears(ctx.forecastYears))[0], base_fiscal_year: baseYear, base_revenue_millions: ratios.base_year?.revenue ?? null };
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
      forecast_period: forecastPeriod,
      recent_reported_history: recentHistory,
      reported_segment_history: reportedSegmentHistory,
      historical_diagnoses: (upstream.historical_diagnosis?.diagnoses || []).map((item: any) => ({
        metric_key: item.metric_key, trend: item.trend, observation_count: item.observation_count, confidence: item.confidence,
      })),
      segments: upstream.segment_model?.segments || [],
      process_nodes: (upstream.business_process_map?.process_nodes || []).map((item: any) => ({
        process_node: item.process_node, financial_line_affected: item.financial_line_affected, main_constraint: item.main_constraint,
      })),
    };

    // Two calls: the forecast, then the reconciliation and reinvestment built on it (split-calls.ts).
    const output = await runSplitStage({
      sql, ctx, stageKey: "operating_model", taskKey, taskType: "operating_model", agentName: "asset-analyst", modelTier: "premium",
      packet, rules: ["Follow output_schema exactly, including every nested required field and primitive type."],
      parts: [
        { name: "forecast", contract: OPERATING_FORECAST_CONTRACT, rules: OPERATING_FORECAST_RULES,
          validate: (value) => forecastPeriodErrors(value, forecastPeriod) },
        { name: "reconciliation", contract: OPERATING_RECONCILIATION_CONTRACT, rules: OPERATING_RECONCILIATION_RULES, after: ["forecast"],
          // The bottom-up total is the accepted segments' forecast revenue; TAM bounds of 0 are missing, not zero.
          normalize: (value, accepted) => {
            const { operating_model: _, ...rest } = normalizeReconciliation({ ...value, operating_model: accepted.operating_model }); // eslint-disable-line @typescript-eslint/no-unused-vars
            return rest;
          } },
      ],
    });
    output.top_down_bottom_up_reconciliation = normalizeReconciliation(output).top_down_bottom_up_reconciliation;

    // Persist generated sub-artifacts
    const db = pipelineDb();
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
        });
      }
    }

    return output;
  },
};
