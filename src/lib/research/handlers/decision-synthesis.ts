import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { DECISION_SYNTHESIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadAcceptedEvidencePacket } from "../sources/corpus";
import { validateArtifactCitationIds } from "../sources/artifact-evidence";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { withheldValuationReason } from "../valuation/contracts";
import { WITHHELD_VALUATION_LINKAGE } from "../decision/validation";

export const decisionSynthesisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "decision_synthesis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const evidenceClaims = await loadAcceptedEvidencePacket(sql, {
        runId: ctx.runId, runType: ctx.runType, assetId: ctx.assetId,
        assetName: ctx.assetName, assetSlug: ctx.assetSlug, symbol: ctx.symbol,
        profileId: ctx.profileId || "", profileKey: ctx.profileKey || "",
        requiredModules: [], requiredLenses: [],
        marketDataCutoffAt: ctx.marketDataCutoffAt?.toISOString() || null,
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      });
      const [backtestReview] = await sql`
        SELECT content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'backtest_review'
          AND status IN ('validated', 'accepted')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const valuationRows = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('valuation_scenario_set', 'reverse_valuation', 'annual_price_target_path')
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type
      `;
      const [operatingScenarios] = await sql`
        SELECT content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'operating_scenario_set'
          AND status IN ('validated', 'accepted')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const [historicalRecord] = await sql`
        SELECT content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'historical_record'
          AND status IN ('validated', 'accepted')
        LIMIT 1
      `;
      const latestMetrics = Object.values((Array.isArray(historicalRecord?.content_json?.observations)
        ? historicalRecord.content_json.observations : [] as any[])
        .reduce((latest: Record<string, any>, observation: any) => {
          const prior = latest[observation.metric_key];
          const period = Number(observation.fiscal_year) * 10 + Number(observation.fiscal_quarter);
          if (!prior || period > Number(prior.fiscal_year) * 10 + Number(prior.fiscal_quarter)) {
            latest[observation.metric_key] = observation;
          }
          return latest;
        }, {}));
      const acceptedValuation = Object.fromEntries(
        valuationRows.map((row) => [String(row.artifact_type), row.content_json])
      ) as Record<string, any>;
      const valuationWithheld = withheldValuationReason(acceptedValuation.valuation_scenario_set);
      const terminalYear = Number(acceptedValuation.valuation_scenario_set?.terminal_year);
      const marketPrice = Number(acceptedValuation.valuation_scenario_set?.current_market_price);
      const terminalProjection = acceptedValuation.annual_price_target_path?.annual_projections?.find(
        (row: any) => Number(row.fiscal_year) === terminalYear
      );
      const terminalRows = acceptedValuation.annual_price_target_path?.price_target_path?.filter(
        (row: any) => Number(row.fiscal_year) === terminalYear
      ) || [];
      const terminalReturns: Record<string, number> = {};
      if (marketPrice > 0) {
        for (const scenarioType of ["bear", "base", "bull"]) {
          const row = terminalRows.find((item: any) => item.scenario_type === scenarioType);
          if (row && Number.isFinite(Number(row.price_target)) && Number.isFinite(Number(row.dividend_per_share))) {
            terminalReturns[scenarioType] = Number(((Number(row.price_target) + Number(row.dividend_per_share) - marketPrice) / marketPrice).toFixed(6));
          }
        }
      }
      const terminalReturnInputs = Object.keys(terminalReturns).length === 3 ? {
        terminal_year: terminalYear,
        market_price: marketPrice,
        diluted_shares_millions: Number(terminalProjection?.balance_sheet_values?.shares_outstanding_millions),
        reported_diluted_shares: Number(acceptedValuation.valuation_scenario_set?.dilution_assumption?.reported_diluted_weighted_average_shares),
        scenario_returns: terminalReturns,
      } : null;
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["thesis_synthesis"],
        applicable_archetypes: ctx.archetypeKeys,
        applicable_overlays: ctx.overlayKeys,
        backtest_review: backtestReview?.content_json || null,
        accepted_valuation: acceptedValuation,
        terminal_return_inputs: terminalReturnInputs,
        operating_scenario_probabilities: operatingScenarios?.content_json
          ? {
              probability_bear: operatingScenarios.content_json.probability_bear,
              probability_base: operatingScenarios.content_json.probability_base,
              probability_bull: operatingScenarios.content_json.probability_bull,
            }
          : null,
        latest_reported_metrics: latestMetrics,
        output_contract: "decision_synthesis",
        output_schema: DECISION_SYNTHESIS_CONTRACT.schema,
        evidence_claims: evidenceClaims,
      };
      const taskKey = "asset-analyst:decision";

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: DECISION_SYNTHESIS_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Synthesize the final investment decision, including a clear thesis statement, risk factors, and upcoming catalysts.",
          "Use the backtest only as timing/risk evidence. Preserve its proxy-data limitations and do not claim that it proves the fundamental thesis.",
          "If the backtest framework gate did not pass, state exactly: Conclusion withheld - research incomplete.",
          "Follow output_schema exactly. Cover each material, evidence-supported risk, catalyst, thesis breaker, and monitoring indicator; do not limit these registers to a single item.",
          "Copy risk supporting_claim_ids exactly from evidence_claims; never invent UUIDs.",
          "Derive material risks from this asset's business, applicable archetypes, overlays and accepted evidence. Include regulatory capital only when relevant to the business. Explain capital allocation, ownership and dilution where material; do not import another company's metrics. Map confidence to specific evidence gaps.",
          ...(valuationWithheld ? [
            `accepted_valuation is withheld: no price target exists. Begin investment_thesis.expected_return_linkage with exactly: ${WITHHELD_VALUATION_LINKAGE} Set investment_thesis.valuation_accepted_first to false. Set every expected_return_matrix return to 0 and add valuation_withheld: true; those zeros are markers, not estimates. Name the missing valuation inputs in confidence_assessment.`,
          ] : [
            "Set investment_thesis.valuation_accepted_first to true because accepted_valuation is supplied by the completed valuation stage.",
          ]),
          "Use operating_scenario_probabilities for bear, base, and bull weights in every expected-return calculation and narrative. Compute probability_weighted_return from those weights and expected_return_matrix bear_return, base_return, and bull_return.",
          "Use terminal_return_inputs for expected_return_matrix and investment_thesis.expected_return_linkage. The return horizon is terminal_year, not an earlier annual price target. Set dilution_omitted to false only when the accepted terminal projection uses at least the reported diluted share count.",
          "Risk probability and confidence must be between 0 and 1; risk severity must be between 1 and 5.",
          "The decision must remain pending because human review is the approval gate.",
          "Use latest_reported_metrics for monitoring current levels. When a current level is unavailable or stale, set it to null and explain the gap in source_role; never use zero as a missing-data placeholder.",
          "Each KPI must have a stable metric_key matching the captured quarterly history, a precise definition, reporting_basis and unit. Express current levels and bear/bull thresholds in that same unit. When the required series is absent, retain the KPI with current_level null and explain the missing disclosure; do not map it to a different definition.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "decision_synthesis", taskKey,
        taskType: "decision_synthesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: DECISION_SYNTHESIS_CONTRACT,
      });
      const probabilities = packet.operating_scenario_probabilities;
      const returns = output.expected_return_matrix;
      if (returns && terminalReturnInputs) {
        returns.bear_return = terminalReturns.bear;
        returns.base_return = terminalReturns.base;
        returns.bull_return = terminalReturns.bull;
        returns.dilution_omitted = !(terminalReturnInputs.reported_diluted_shares > 0
          && terminalReturnInputs.diluted_shares_millions * 1e6 >= terminalReturnInputs.reported_diluted_shares - 1);
      }
      if (probabilities && returns) {
        const weighted = Number(probabilities.probability_bear) * Number(returns.bear_return)
          + Number(probabilities.probability_base) * Number(returns.base_return)
          + Number(probabilities.probability_bull) * Number(returns.bull_return);
        if (Number.isFinite(weighted)) returns.probability_weighted_return = Number(weighted.toFixed(6));
      }
      if (terminalReturnInputs && output.investment_thesis && probabilities && returns) {
        output.investment_thesis.horizon = `Through fiscal ${terminalYear}`;
        output.investment_thesis.expected_return_linkage =
          `Fiscal ${terminalYear} diluted-share price targets imply bear ${(returns.bear_return * 100).toFixed(1)}%, ` +
          `base ${(returns.base_return * 100).toFixed(1)}%, and bull ${(returns.bull_return * 100).toFixed(1)}% ` +
          `total returns from $${marketPrice.toFixed(2)}; operating scenario weights ` +
          `${(Number(probabilities.probability_bear) * 100).toFixed(0)}/${(Number(probabilities.probability_base) * 100).toFixed(0)}/${(Number(probabilities.probability_bull) * 100).toFixed(0)} ` +
          `produce ${(returns.probability_weighted_return * 100).toFixed(1)}%. ` +
          `Future share issuance beyond the reported diluted count remains a source gap.`;
      }
      // Without a valuation there are no returns or price-based conclusion; keep the decision pending.
      if (valuationWithheld) {
        if (returns) {
          for (const key of ["bear_return", "base_return", "bull_return", "probability_weighted_return", "no_rerating_return", "weak_stock_outcome", "permanent_loss_limit"]) returns[key] = 0;
          Object.assign(returns, { valuation_withheld: true, withheld_reason: valuationWithheld });
        }
        if (output.investment_thesis) {
          output.investment_thesis.valuation_accepted_first = false;
          const raw = String(output.investment_thesis.expected_return_linkage || "");
          const linkage = (raw.startsWith(WITHHELD_VALUATION_LINKAGE) ? raw.slice(WITHHELD_VALUATION_LINKAGE.length) : raw).trim();
          output.investment_thesis.expected_return_linkage = `${WITHHELD_VALUATION_LINKAGE} ${linkage || valuationWithheld}`.trim();
        }
        if (output.decision_record) output.decision_record.decision = "pending";
      }
      const monitoringItems = output.monitoring_dashboard?.items;
      if (Array.isArray(monitoringItems)) {
        const latestDeposits = (latestMetrics as any[]).find((metric) => metric.metric_key === "deposits");
        const reportedDilutedShares = terminalReturnInputs?.reported_diluted_shares ?? 0;
        for (const item of monitoringItems) {
          if (/total deposits/i.test(String(item.kpi)) && latestDeposits?.value_numeric != null) {
            item.current_level = /billion/i.test(String(item.kpi))
              ? Number((Number(latestDeposits.value_numeric) / 1e9).toFixed(6))
              : Number(latestDeposits.value_numeric);
            item.source_role = `SEC companyfacts ${latestDeposits.fiscal_year}Q${latestDeposits.fiscal_quarter}`;
          } else if (/diluted shares/i.test(String(item.kpi)) && reportedDilutedShares > 0) {
            item.current_level = /million/i.test(String(item.kpi))
              ? Number((reportedDilutedShares / 1e6).toFixed(6))
              : reportedDilutedShares;
            item.source_role = `SEC companyfacts quarter ended ${acceptedValuation.valuation_scenario_set?.dilution_assumption?.reported_period_end}`;
          } else if (/not provided|requires current update|stale/i.test(String(item.source_role || ""))) {
            item.current_level = null;
          }
        }
      }
      const citationValidation = validateArtifactCitationIds(
        output,
        evidenceClaims.map((claim: any) => String(claim.id))
      );
      if (!citationValidation.valid) {
        throw new Error(
          `Decision synthesis cited evidence IDs outside the accepted packet: ${citationValidation.invalidIds.join(", ")}`
        );
      }

      // Persist to theses table
      const thesis = output.investment_thesis as any || {};
      await sql`
        INSERT INTO theses (
          asset_id, research_run_id, one_sentence_thesis, why_now, market_missing, status, created_by
        )
        SELECT
          ${ctx.assetId}, ${ctx.runId}, ${thesis.thesis_statement || thesis.one_sentence_thesis || "Thesis statement"},
          ${thesis.why_now || thesis.causal_chain || null},
          ${thesis.market_missing || thesis.market_mispricing || null},
          'draft', 'system-research-os'
        WHERE NOT EXISTS (
          SELECT 1 FROM theses WHERE research_run_id = ${ctx.runId}
        )
      `;

      // Persist to risks table
      const riskAssessment = output.risk_register as any || output.risk_assessment as any || {};
      const risks = Array.isArray(riskAssessment.risks) ? riskAssessment.risks : [];
      for (const r of risks) {
        await sql`
          INSERT INTO risks (
            asset_id, research_run_id, risk_name, risk_type, description, severity, probability,
            evidence_claim_ids, mitigants_json
          )
          SELECT
            ${ctx.assetId}, ${ctx.runId}, ${r.risk_name || "Risk factor"}, ${r.risk_type || "market"},
            ${r.description || r.causal_mechanism || null}, ${String(r.severity || "medium")},
            ${String(r.probability ?? "medium")},
            ${sql.array(Array.isArray(r.supporting_claim_ids) ? r.supporting_claim_ids : [])}::uuid[],
            ${sql.json(Array.isArray(r.mitigants) ? r.mitigants : [])}
          WHERE NOT EXISTS (
            SELECT 1 FROM risks
            WHERE research_run_id = ${ctx.runId} AND risk_name = ${r.risk_name || "Risk factor"}
          )
        `;
      }

      // Persist to catalysts table
      const catalystTimeline = output.catalyst_register as any || output.catalyst_timeline as any || {};
      const catalysts = Array.isArray(catalystTimeline.catalysts) ? catalystTimeline.catalysts : [];
      for (const cat of catalysts) {
        await sql`
          INSERT INTO catalysts (
            asset_id, research_run_id, catalyst_name, catalyst_type, description, upside_downside, status
          )
          SELECT
            ${ctx.assetId}, ${ctx.runId}, ${cat.catalyst_name || "Catalyst event"}, ${cat.catalyst_type || "earnings"},
            ${cat.description || cat.event_mechanism || null},
            ${cat.upside_downside || cat.direction || "neutral"}, 'open'
          WHERE NOT EXISTS (
            SELECT 1 FROM catalysts
            WHERE research_run_id = ${ctx.runId}
              AND catalyst_name = ${cat.catalyst_name || "Catalyst event"}
          )
        `;
      }

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = DECISION_SYNTHESIS_CONTRACT.requiredKeys;
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
