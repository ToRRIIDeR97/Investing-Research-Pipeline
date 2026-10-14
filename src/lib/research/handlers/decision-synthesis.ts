import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { DECISION_SYNTHESIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadAcceptedEvidencePacket, reconcileSourceGaps } from "../sources/corpus";
import { v2RunContext } from "../sources/role-coverage";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { withheldValuationReason } from "../valuation/contracts";
import {
  DECISION_GAP_OWNER, decisionOutputFormat, finalizeDecisionOutput, stripCodeOwnedFields, type DecisionFinalizeInputs,
} from "../decision/finalize";

type Sql = ReturnType<typeof postgres>;

/**
 * Write the thesis, risks and catalysts tables from this attempt's output in one transaction.
 * A retry or re-run replaces the earlier attempt's rows: the thesis is updated in place (thesis_drivers
 * reference it), and risks and catalysts, which nothing references, are deleted and rewritten.
 */
export async function persistDecisionRows(sql: Sql, ctx: Pick<ResearchRunContext, "runId" | "assetId">, output: Record<string, any>) {
  const thesis = output.investment_thesis as any || {};
  const riskAssessment = output.risk_register as any || output.risk_assessment as any || {};
  const risks = Array.isArray(riskAssessment.risks) ? riskAssessment.risks : [];
  const catalystTimeline = output.catalyst_register as any || output.catalyst_timeline as any || {};
  const catalysts = Array.isArray(catalystTimeline.catalysts) ? catalystTimeline.catalysts : [];
  await sql.begin(async (tx) => {
    const statement = thesis.thesis_statement || thesis.one_sentence_thesis || "Thesis statement";
    const whyNow = thesis.why_now || thesis.causal_chain || null;
    const marketMissing = thesis.market_missing || thesis.market_mispricing || null;
    const updated = await tx`
      UPDATE theses SET one_sentence_thesis = ${statement}, why_now = ${whyNow}, market_missing = ${marketMissing}, updated_at = NOW()
      WHERE research_run_id = ${ctx.runId}
    `;
    if (!updated.count) await tx`
      INSERT INTO theses (asset_id, research_run_id, one_sentence_thesis, why_now, market_missing, status, created_by)
      VALUES (${ctx.assetId}, ${ctx.runId}, ${statement}, ${whyNow}, ${marketMissing}, 'draft', 'system-research-os')
    `;
    await tx`DELETE FROM risks WHERE research_run_id = ${ctx.runId}`;
    for (const r of risks) {
      // A name repeated within one answer is stored once.
      await tx`
        INSERT INTO risks (
          asset_id, research_run_id, risk_name, risk_type, description, severity, probability,
          evidence_claim_ids, mitigants_json
        )
        SELECT
          ${ctx.assetId}, ${ctx.runId}, ${r.risk_name || "Risk factor"}, ${r.risk_type || "market"},
          ${r.description || r.causal_mechanism || null}, ${String(r.severity || "medium")},
          ${String(r.probability ?? "medium")},
          ${tx.array(Array.isArray(r.supporting_claim_ids) ? r.supporting_claim_ids : [])}::uuid[],
          ${tx.json(Array.isArray(r.mitigants) ? r.mitigants : [])}
        WHERE NOT EXISTS (
          SELECT 1 FROM risks
          WHERE research_run_id = ${ctx.runId} AND risk_name = ${r.risk_name || "Risk factor"}
        )
      `;
    }
    await tx`DELETE FROM catalysts WHERE research_run_id = ${ctx.runId}`;
    for (const cat of catalysts) {
      await tx`
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
  });
}

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
      const weights = operatingScenarios?.content_json || {};
      const finalizeInputs: DecisionFinalizeInputs = {
        acceptedClaimIds: evidenceClaims.map((claim: any) => String(claim.id)),
        valuation: {
          status: valuationWithheld ? "withheld" : "complete",
          terminalYear: Number.isFinite(terminalYear) ? terminalYear : undefined,
          withheldReason: valuationWithheld || undefined,
        },
        marketPrice: marketPrice > 0 ? marketPrice : null,
        terminalReturns: terminalReturnInputs
          ? { bear: terminalReturns.bear, base: terminalReturns.base, bull: terminalReturns.bull } : null,
        probabilities: ["bear", "base", "bull"].every((t) => Number.isFinite(weights[`probability_${t}`]))
          ? { probability_bear: weights.probability_bear, probability_base: weights.probability_base, probability_bull: weights.probability_bull }
          : null,
        dilutionCovered: Boolean(terminalReturnInputs && terminalReturnInputs.reported_diluted_shares > 0
          && terminalReturnInputs.diluted_shares_millions * 1e6 >= terminalReturnInputs.reported_diluted_shares - 1),
      };

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
            "accepted_valuation is withheld: no price target exists. Do not state price targets or returns; use investment_thesis.expected_return_linkage to say what the conclusion depends on, and name the missing valuation inputs in confidence_assessment.",
          ] : []),
          "Code sets investment_thesis.valuation_accepted_first and the expected_return_matrix status, bear, base, bull and probability-weighted returns and dilution_omitted from accepted_valuation, terminal_return_inputs and operating_scenario_probabilities; values you give for them are replaced. Judge no_rerating_return, weak_stock_outcome and permanent_loss_limit over the terminal_year horizon.",
          "Risk probability and confidence must be between 0 and 1; risk severity must be between 1 and 5.",
          "The decision must remain pending because human review is the approval gate.",
          "Use latest_reported_metrics for monitoring current levels. When a current level is unavailable or stale, set it to null and explain the gap in source_role; never use zero as a missing-data placeholder.",
          "Each KPI must have a stable metric_key matching the captured quarterly history, a precise definition, reporting_basis and unit. Express current levels and bear/bull thresholds in that same unit. When the required series is absent, retain the KPI with current_level null and explain the missing disclosure; do not map it to a different definition.",
        ],
      });

      const raw = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "decision_synthesis", taskKey,
        taskType: "decision_synthesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: decisionOutputFormat(finalizeInputs),
      });
      // The model-facing format already judged a finalized copy; finalizing again yields the same output.
      const { output, adjustments, gaps, errors } = finalizeDecisionOutput(stripCodeOwnedFields(raw), finalizeInputs);
      if (adjustments.dropped_citation_ids.length) {
        console.warn(`decision synthesis dropped citations outside the accepted packet: ${adjustments.dropped_citation_ids.join(", ")}`);
      }
      // Captured current levels replace the model's for KPIs the history and valuation report directly.
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
      // Check everything before the first write, so an invalid answer never leaves partial rows.
      const problems = [...errors, ...(DECISION_SYNTHESIS_CONTRACT.validate?.(output) || [])];
      if (problems.length) {
        throw new Error(`Decision synthesis output is invalid: ${problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`);
      }

      await persistDecisionRows(sql, ctx, output);

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
          });
        }
      }
      // Source-gap and uncited risks are evidence gaps, not operating risks. Gaps an earlier attempt
      // opened and this one no longer produces are resolved, so a re-run converges.
      await reconcileSourceGaps(sql, v2RunContext(ctx), { source_gaps: gaps }, DECISION_GAP_OWNER);

      return output;
    } finally {
      await sql.end();
    }
  },
};
