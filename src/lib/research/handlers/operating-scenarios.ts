import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { OPERATING_SCENARIOS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { valuationFinancialInputs } from "../valuation/financial-inputs";
import { buildScenarioStatements, forecastHorizon, forecastYears, historyRatios, operatingModelFirstYear, validateScenarioDriverCoverage } from "../valuation/engine";

/**
 * Post-processing text about the copied reinvestment_model. It states the values actually copied;
 * the zero-capex placeholder sentence appears only when there is no capex forecast, and an empty
 * working-capital forecast keeps the model's own text and is recorded as a source gap.
 */
export function reinvestmentNotes(reinvestment: { capex_forecast?: unknown; working_capital_forecast: number[]; units?: string }) {
  const units = reinvestment.units || "USD millions";
  const capex = (Array.isArray(reinvestment.capex_forecast) ? reinvestment.capex_forecast : []).map(Number);
  const hasCapex = capex.some((value) => Number.isFinite(value) && value !== 0);
  const workingCapital = reinvestment.working_capital_forecast;
  const sensitivity = workingCapital.length ? "funding surplus varies with scenario revenue as a sensitivity" : "";
  return {
    baseWorkingCapital: workingCapital.length
      ? `Base funding-surplus proxy from reinvestment_model: ${workingCapital.join(", ")} ${units}.` : null,
    baseReinvestment: hasCapex
      ? `Base capex copies the accepted reinvestment_model: ${capex.join(", ")} ${units}${workingCapital.length ? "; so does the funding-surplus proxy" : ""}.`
      : "Base capex and funding-surplus proxy copy the accepted reinvestment_model; zero capex is a disclosed missing-data placeholder.",
    scenarioReinvestment: hasCapex
      ? `Base capex from reinvestment_model is ${capex.join(", ")} ${units}; this scenario's yearly capex follows its drivers and history_ratios${sensitivity ? `, and ${sensitivity}` : ""}.`
      : `Capex remains an unsourced zero placeholder${sensitivity ? `; ${sensitivity}` : ""}.`,
    sourceGaps: workingCapital.length ? [] : ["reinvestment_model has no working_capital_forecast, so no funding-surplus proxy was copied into the scenarios."],
  };
}

export const operatingScenariosHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "operating_scenarios",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "forecast-analyst:scenarios";
      const upstreamRows = await sql`
        SELECT artifact_type, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('operating_model', 'driver_tree', 'top_down_bottom_up_reconciliation', 'reinvestment_model')
          AND status IN ('validated', 'accepted')
      `;
      const forecastArtifacts = Object.fromEntries(
        upstreamRows.map((row) => [String(row.artifact_type), row.content_json])
      ) as Record<string, any>;
      // The horizon starts after the latest captured fiscal year; code builds each year's statements from the drivers.
      const [statementSet] = await sql`
        SELECT content_json->'observations' AS observations, content_json ? 'quarter_coverage' AS foreign_issuer FROM research_artifacts
        WHERE research_run_id = ${ctx.runId} AND artifact_type = 'financial_statement_set' AND status IN ('validated', 'accepted')
        ORDER BY created_at DESC LIMIT 1
      `;
      const cutoff = ctx.marketDataCutoffAt || ctx.cutoffAt;
      const financialInputs = valuationFinancialInputs({
        statementObservations: Array.isArray(statementSet?.observations) ? statementSet.observations : [], cutoff,
        foreignIssuer: statementSet?.foreign_issuer === true,
      });
      const ratios = historyRatios(financialInputs);
      const baseYear = ratios.base_year?.fiscal_year ?? cutoff.getUTCFullYear() - 1;
      const horizon = forecastHorizon(baseYear, forecastYears(ctx.forecastYears));
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["scenario_specifications", "bear_base_bull_ranges", "operating_scenarios"],
        forecast_artifacts: forecastArtifacts,
        forecast_horizon: { base_fiscal_year: baseYear, years: horizon },
        history_ratios: { units: `${financialInputs?.currency ?? "reporting currency"} millions`, ...ratios },
        output_contract: "operating_scenarios",
        output_schema: OPERATING_SCENARIOS_CONTRACT.schema,
      };

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: OPERATING_SCENARIOS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Establish probabilistic base, bull, and bear scenario assumptions for all forecast drivers.",
          "Every case needs numeric_assumptions for each material driver and forecast year: driver_key, fiscal_year, numeric value, explicit unit, rationale and source_ids. Analyst assumptions may have no source IDs but must explain their calibration. No qualitative placeholder substitutes for a numeric assumption. Keep them consistent with the resulting financial statements.",
          "Follow output_schema exactly and return exactly one bear, one base, and one bull scenario.",
          "Keep the base scenario consistent with forecast_artifacts; explain deviations in bear and bull assumptions.",
          "Copy the operating_model base revenue, operating income, and segment values exactly. Copy reinvestment_model working_capital_forecast exactly for the base case; it is a funding-surplus proxy, not a negative working-capital balance.",
          "Every scenario needs yearly_drivers with one entry per year in forecast_horizon.years: fiscal_year, revenue_growth and operating_margin as decimals. Add capex_to_revenue, da_to_revenue, tax_rate or nwc_to_revenue_change only where history_ratios should not apply. The application builds each year's revenue, operating income, D&A, capex, NOPAT and FCFF from these drivers and history_ratios (D&A rolls forward from net PP&E when history_ratios.ppe is given, so capex raises later D&A); the base case's first year takes revenue and operating income from operating_model.",
          "Where the company reports segments, add segment_operating_income to each yearly_drivers entry: [{segment, operating_income}] in currency millions, including any corporate or reconciling line, summing to that year's operating income (revenue x operating_margin) within 0.5%. The application values loss-making segments separately as a cross-check.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "operating_scenarios", taskKey,
        taskType: "operating_scenarios", agentName: "asset-analyst", modelTier: "premium",
        packet, promptFactory,
        outputFormat: { ...OPERATING_SCENARIOS_CONTRACT, validate(value: unknown) {
          const errors = OPERATING_SCENARIOS_CONTRACT.validate?.(value) || [];
          if (errors.length) return errors;
          return validateScenarioDriverCoverage((value as any)?.operating_scenario_set, horizon)
            .map((message) => ({ path: "operating_scenario_set.scenarios", message }));
        } },
      });
      const scenarioSet = output.operating_scenario_set;
      const model = forecastArtifacts.operating_model;
      const reinvestment = forecastArtifacts.reinvestment_model;
      const base = scenarioSet?.scenarios?.find((item: any) => item.scenario_type === "base");
      const baseStatements = base?.resulting_financial_statements_json;
      if (!model || !reinvestment || !baseStatements || !Array.isArray(model.segments)
        || !Array.isArray(reinvestment.working_capital_forecast)) {
        throw new Error("Operating scenarios require the accepted operating model and reinvestment forecast");
      }
      baseStatements.consolidated_revenue = model.consolidated_revenue;
      baseStatements.consolidated_operating_income = model.consolidated_operating_income;
      baseStatements.segment_revenue = Object.fromEntries(
        model.segments.map((segment: any) => [segment.segment_name, segment.forecast_revenue])
      );
      baseStatements.segment_operating_income = Object.fromEntries(
        model.segments.map((segment: any) => [segment.segment_name, segment.forecast_operating_income])
      );
      baseStatements.working_capital_forecast = reinvestment.working_capital_forecast;
      baseStatements.capex_forecast = reinvestment.capex_forecast;
      baseStatements.forecast_horizon = model.forecast_horizon;
      const notes = reinvestmentNotes(reinvestment);
      if (notes.baseWorkingCapital) base.working_capital = notes.baseWorkingCapital;
      base.reinvestment = notes.baseReinvestment;
      if (notes.sourceGaps.length) scenarioSet.source_gaps = [...(Array.isArray(scenarioSet.source_gaps) ? scenarioSet.source_gaps : []), ...notes.sourceGaps];
      baseStatements.deviation_from_base = "None; base financial values copy the accepted operating_model and reinvestment_model.";
      let fundingSensitivityApplied = false;
      for (const scenario of scenarioSet.scenarios) {
        if (scenario.scenario_type === "base") continue;
        const statements = scenario.resulting_financial_statements_json;
        const ratio = Number(statements?.consolidated_revenue) / Number(model.consolidated_revenue);
        if (!(ratio > 0)) continue;
        if (notes.baseWorkingCapital) {
          fundingSensitivityApplied = true;
          statements.working_capital_forecast = reinvestment.working_capital_forecast.map(
            (value: number) => Number((value * ratio).toFixed(3))
          );
          scenario.working_capital = `Funding-surplus sensitivity scales the base reinvestment_model proxy by ${ratio.toFixed(3)}x scenario revenue; this is an analyst assumption, not reported guidance.`;
        }
        scenario.reinvestment = notes.scenarioReinvestment;
        const revenueChange = (ratio - 1) * 100;
        const incomeChange = (Number(statements.consolidated_operating_income) / Number(model.consolidated_operating_income) - 1) * 100;
        statements.deviation_from_base = `Revenue ${revenueChange.toFixed(1)}% and operating income ${incomeChange.toFixed(1)}% versus the accepted base forecast; scenario driver assumptions are analyst judgments.`;
        const baseMargin = Number(model.consolidated_operating_income) / Number(model.consolidated_revenue);
        const scenarioMargin = Number(statements.consolidated_operating_income) / Number(statements.consolidated_revenue);
        if (scenario.scenario_type === "bull" && scenarioMargin < baseMargin) {
          scenario.margin_formation = "Modeled revenue rises faster than operating income, so consolidated operating margin falls below base. Assumed NIM and credit improvements do not establish overall margin expansion; the offsetting costs or mix are not independently sourced.";
          scenarioSet.source_gaps = [
            ...(Array.isArray(scenarioSet.source_gaps) ? scenarioSet.source_gaps : []),
            "Bull-case operating margin is below base despite assumed NIM and credit improvements; offsetting costs or mix require validation.",
          ];
        }
      }
      scenarioSet.forecast_horizon = { base_fiscal_year: baseYear, years: horizon };
      const baseRevenue = ratios.base_year?.revenue;
      if (baseRevenue) {
        const firstYear = operatingModelFirstYear(model, baseRevenue);
        for (const scenario of scenarioSet.scenarios) {
          const years = buildScenarioStatements({
            baseRevenue, baseYear, ratios, firstYear: scenario.scenario_type === "base" ? firstYear : null,
            drivers: scenario.yearly_drivers.filter((driver: any) => horizon.includes(driver.fiscal_year)),
          });
          Object.assign(scenario.resulting_financial_statements_json, {
            units: `${financialInputs?.currency ?? "USD"} millions`,
            years: Object.fromEntries(years.map((year) => [year.fiscal_year, year])),
          });
        }
        if (!firstYear) scenarioSet.source_gaps = [...(Array.isArray(scenarioSet.source_gaps) ? scenarioSet.source_gaps : []),
          `The base case's FY${horizon[0]} statements use its drivers: operating_model revenue could not be matched to FY${baseYear} revenue in millions.`];
      } else {
        scenarioSet.source_gaps = [...(Array.isArray(scenarioSet.source_gaps) ? scenarioSet.source_gaps : []),
          "No annual revenue was captured in financial_inputs, so yearly statements were not built from the drivers."];
      }
      if (fundingSensitivityApplied) {
        scenarioSet.source_gaps = [
          ...(Array.isArray(scenarioSet.source_gaps) ? scenarioSet.source_gaps : []),
          "Bear and bull funding-surplus values are revenue-scaled sensitivities of the base proxy; no scenario-specific company guidance is available.",
        ];
      }

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
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
};
