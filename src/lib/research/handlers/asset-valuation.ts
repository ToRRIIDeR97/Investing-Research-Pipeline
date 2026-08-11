import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { VALUATION_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { missingRequiredValuationMethods } from "../valuation/contracts";

export const assetValuationHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "asset_valuation",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const [profile] = ctx.profileId
        ? await sql`
            SELECT required_valuation_lenses_json, required_modules_json
            FROM research_profiles
            WHERE id = ${ctx.profileId}
            LIMIT 1
          `
        : [];
      const requiredLenses = Array.isArray(profile?.required_valuation_lenses_json)
        ? profile.required_valuation_lenses_json.map(String)
        : (ctx.composedProfile?.valuation_methods.map((method: any) => String(method.method)) || ["reverse_dcf"]);
      const requiredModules = Array.isArray(profile?.required_modules_json)
        ? profile.required_modules_json.map(String)
        : [];
      const upstreamRows = await sql`
        SELECT artifact_type, content_json
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('operating_model', 'operating_scenario_set', 'driver_tree')
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type
      `;
      const upstream = Object.fromEntries(
        upstreamRows.map((row) => [String(row.artifact_type), row.content_json])
      ) as Record<string, any>;
      const scenarioSetInput = upstream.operating_scenario_set || {};
      const compactScenarios = {
        probability_bear: scenarioSetInput.probability_bear,
        probability_base: scenarioSetInput.probability_base,
        probability_bull: scenarioSetInput.probability_bull,
        scenarios: Array.isArray(scenarioSetInput.scenarios)
          ? scenarioSetInput.scenarios.map((scenario: any) => ({
              scenario_type: scenario.scenario_type,
              resulting_financial_statements_json: scenario.resulting_financial_statements_json,
            }))
          : [],
      };
      const metricRows = await sql`
        SELECT md.metric_key, mo.period_end, mo.value_numeric, mo.value_text, mo.unit, mo.currency
        FROM metric_observations mo
        JOIN metric_definitions md ON md.id = mo.metric_definition_id
        WHERE mo.research_run_id = ${ctx.runId}
          AND mo.review_status = 'accepted'
        ORDER BY mo.period_end DESC NULLS LAST, md.metric_key
        LIMIT 80
      `;
      const [marketRow] = await sql`
        SELECT dc.text
        FROM research_run_sources rrs
        JOIN source_documents sd ON sd.id = rrs.source_document_id
        JOIN document_parses dp ON dp.source_document_id = sd.id
        JOIN document_chunks dc ON dc.document_parse_id = dp.id
        WHERE rrs.research_run_id = ${ctx.runId}
          AND sd.source_type = 'market_data_snapshot'
        ORDER BY sd.retrieved_at DESC, dc.chunk_index ASC
        LIMIT 1
      `;
      let marketSnapshot: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(marketRow?.text || "{}"));
        const meta = parsed?.meta || {};
        marketSnapshot = {
          retrieved_at: parsed?.retrieved_at,
          currency: meta.currency,
          regular_market_price: meta.regularMarketPrice,
          fifty_two_week_high: meta.fiftyTwoWeekHigh,
          fifty_two_week_low: meta.fiftyTwoWeekLow,
        };
      } catch {
        marketSnapshot = {};
      }
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_lenses: requiredLenses,
        required_modules: requiredModules,
        current_market_snapshot: marketSnapshot,
        accepted_historical_metrics: metricRows,
        operating_model: upstream.operating_model || null,
        operating_scenarios: compactScenarios,
        valuation_method_protocol: {
          required_model_keys: ["driver_based_dcf"],
        },
        output_schema: VALUATION_CONTRACT.schema,
      };
      const taskKey = `valuation-analyst:valuation:v3:${createHash("sha256")
        .update(JSON.stringify(packet))
        .digest("hex")
        .slice(0, 12)}`;

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "valuation-analyst",
        requiredKeys: VALUATION_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Every method named in required_lenses must be used explicitly as valuation_method in annual_price_target_path. A cross-check method cannot substitute for a required primary lens.",
          "Provide per-share valuation targets and probabilistic scenarios.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          "annual_price_target_path must include bear, base, and bull price targets for every fiscal year through terminal_year.",
          "Use the supplied operating-scenario financial statements, accepted historical metrics, cash, dilution, and current market price. Do not claim these inputs are absent when they are in the packet.",
          "For a pre-profit company, use scenario-appropriate revenue, cash/NAV, reverse-valuation, and dilution-aware methods when earnings or FCF multiples are not meaningful.",
          "All three terminal anchors and annual price targets must be positive finite per-share values. Preserve uncertainty through a wide bear/base/bull range rather than zero placeholders.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "asset_valuation", taskKey,
        taskType: "asset_valuation", agentName: "valuation-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: VALUATION_CONTRACT,
      });

      const scenarioSet = output.valuation_scenario_set || {};
      const targetPath = output.annual_price_target_path || {};
      const missingLenses = missingRequiredValuationMethods(requiredLenses, targetPath.price_target_path || []);
      if (missingLenses.length) {
        throw new Error(`Valuation omitted required method(s): ${missingLenses.join(", ")}`);
      }
      const derivedScenarios = ["bear", "base", "bull"].map((scenarioType) => ({
        scenario_name: `${scenarioType} valuation`,
        scenario_type: scenarioType,
        value_anchor: Number(scenarioSet[`terminal_anchor_${scenarioType}`]),
        assumptions_json: {
          terminal_year: scenarioSet.terminal_year,
          price_target_path: Array.isArray(targetPath.price_target_path)
            ? targetPath.price_target_path.filter((row: any) => row.scenario_type === scenarioType)
            : [],
        },
        confidence: scenarioType === "base" ? 0.7 : 0.55,
      })).filter((scenario) => Number.isFinite(scenario.value_anchor) && scenario.value_anchor > 0);
      if (derivedScenarios.length !== 3) {
        throw new Error("Valuation did not produce positive finite bear, base, and bull terminal anchors.");
      }
      const baseAnchor = derivedScenarios.find((scenario) => scenario.scenario_type === "base")?.value_anchor;
      const comparisonRange = Object.fromEntries(
        derivedScenarios.map((scenario) => [scenario.scenario_type, scenario.value_anchor])
      );
      const usedMethods = [...new Set((targetPath.price_target_path || []).map((row: any) => String(row.valuation_method)))] as string[];
      const derivedSignals = derivedScenarios.length === 3
        ? [
            {
              signal_key: "scenario_price_target_range",
              signal_name: "Scenario price target range",
              lens_family: "scenario_valuation",
              current_value_text: String(baseAnchor),
              comparison_range_json: comparisonRange,
              signal: "scenario_range",
              cheapness_score: 0.5,
              confidence: 0.7,
            },
            ...usedMethods.map((lens) => ({
              signal_key: `${lens}_scenario_price_target`,
              signal_name: `${lens} scenario price target`,
              lens_family: lens,
              current_value_text: String(baseAnchor),
              comparison_range_json: comparisonRange,
              signal: "inconclusive",
              cheapness_score: 0.5,
              confidence: 0.65,
            })),
          ]
        : [];

      // Persist compatibility rows consumed by the workflow gate and exports.
      const signals = Array.isArray(output.valuation_signals) ? output.valuation_signals : derivedSignals;
      for (const sig of signals) {
        const updated = await sql`
          UPDATE valuation_signals
          SET signal_name = ${sig.signal_name}, lens_family = ${sig.lens_family},
              current_value_text = ${sig.current_value_text || null},
              comparison_range_json = ${sql.json(sig.comparison_range_json || {})},
              signal = ${sig.signal}, cheapness_score = ${sig.cheapness_score || null},
              confidence = ${sig.confidence || null}, review_status = 'accepted'
          WHERE research_run_id = ${ctx.runId} AND signal_key = ${sig.signal_key}
        `;
        if (updated.count > 0) continue;
        await sql`
          INSERT INTO valuation_signals (
            asset_id, research_run_id, profile_id, signal_key, signal_name, lens_family,
            current_value_text, comparison_range_json, signal, cheapness_score, confidence, review_status
          )
          SELECT
            ${ctx.assetId}, ${ctx.runId}, ${ctx.profileId}, ${sig.signal_key}, ${sig.signal_name}, ${sig.lens_family},
            ${sig.current_value_text || null}, ${sql.json(sig.comparison_range_json || {})},
            ${sig.signal}, ${sig.cheapness_score || null}, ${sig.confidence || null}, 'accepted'
          WHERE NOT EXISTS (
            SELECT 1 FROM valuation_signals
            WHERE research_run_id = ${ctx.runId} AND signal_key = ${sig.signal_key}
          )
        `;
      }

      // Persist to scenarios table
      const scens = Array.isArray(output.scenarios) ? output.scenarios : derivedScenarios;
      for (const scen of scens) {
        const updated = await sql`
          UPDATE scenarios
          SET scenario_name = ${scen.scenario_name}, value_anchor = ${scen.value_anchor || null},
              assumptions_json = ${sql.json(scen.assumptions_json || {})},
              confidence = ${scen.confidence || null}, review_status = 'accepted'
          WHERE research_run_id = ${ctx.runId} AND scenario_type = ${scen.scenario_type}
        `;
        if (updated.count > 0) continue;
        await sql`
          INSERT INTO scenarios (
            asset_id, research_run_id, scenario_name, scenario_type, value_anchor,
            assumptions_json, confidence, review_status
          )
          SELECT
            ${ctx.assetId}, ${ctx.runId}, ${scen.scenario_name}, ${scen.scenario_type}, ${scen.value_anchor || null},
            ${sql.json(scen.assumptions_json || {})}, ${scen.confidence || null}, 'accepted'
          WHERE NOT EXISTS (
            SELECT 1 FROM scenarios
            WHERE research_run_id = ${ctx.runId} AND scenario_type = ${scen.scenario_type}
          )
        `;
      }

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = VALUATION_CONTRACT.requiredKeys;
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
      const artifactKeys = VALUATION_CONTRACT.requiredKeys;
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
