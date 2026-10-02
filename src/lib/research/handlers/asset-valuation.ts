import { completeV3Task, createV3Task } from "../run-context";
import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { VALUATION_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { latestSecInstantFact, latestSecQuarterlyFact } from "../history/sec-companyfacts";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { projectionSharesInMillions, projectionShareUnitErrors } from "../valuation/share-denominator";
import {calculateValuationSchedule} from '../valuation/schedules';

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
          AND artifact_type IN ('operating_model', 'operating_scenario_set', 'driver_tree', 'top_down_bottom_up_reconciliation', 'reinvestment_model')
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
              numeric_assumptions: scenario.numeric_assumptions,
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
        JOIN document_parses dp ON dp.source_document_id = sd.id AND dp.parser_name <> 'research-memory'
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
      const [primaryDoc] = await sql`
        SELECT d.id, d.storage_path
        FROM source_documents d
        JOIN research_run_sources r ON r.source_document_id = d.id
        WHERE r.research_run_id = ${ctx.runId} AND d.source_type = 'primary_source_context'
        LIMIT 1
      `;
      let navInputs: Record<string, unknown> | null = null;
      let reportedDilutedShares: { value: number; start: string; end: string; filed: string; accession_number: string } | null = null;
      if (primaryDoc?.storage_path) {
        const sourceRoot = resolve(process.cwd(), "storage", "sources");
        const sourcePath = resolve(process.cwd(), String(primaryDoc.storage_path));
        if (!sourcePath.startsWith(sourceRoot + sep)) throw new Error("Invalid primary source path");
        const companyFacts = JSON.parse(await readFile(sourcePath, "utf8")).companyFacts;
        const cutoff = ctx.marketDataCutoffAt || ctx.cutoffAt;
        const equity = latestSecInstantFact(companyFacts, "us-gaap", "StockholdersEquity", "USD", cutoff);
        const goodwill = latestSecInstantFact(companyFacts, "us-gaap", "Goodwill", "USD", cutoff);
        const intangibles = latestSecInstantFact(companyFacts, "us-gaap", "IntangibleAssetsNetExcludingGoodwill", "USD", cutoff);
        const shares = latestSecInstantFact(companyFacts, "dei", "EntityCommonStockSharesOutstanding", "shares", cutoff);
        reportedDilutedShares = latestSecQuarterlyFact(
          companyFacts, "us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", "shares", cutoff
        );
        if (reportedDilutedShares) {
          const shareFact = reportedDilutedShares;
          const [chunk] = await sql`
            SELECT dc.id, dc.document_parse_id, dc.char_start, dc.char_end, dc.text
            FROM document_chunks dc
            JOIN document_parses dp ON dp.id = dc.document_parse_id AND dp.parser_name <> 'research-memory'
            WHERE dc.source_document_id = ${primaryDoc.id}
              AND dc.text LIKE ${`%"val": ${shareFact.value}%`}
            ORDER BY dc.chunk_index
            LIMIT 1
          `;
          if (!chunk || !String(chunk.text).includes(shareFact.start)
            || !String(chunk.text).includes(shareFact.end)
            || !String(chunk.text).includes(shareFact.accession_number)) {
            throw new Error("SEC diluted-share fact could not be linked to its source chunk");
          }
          const claimText = `${ctx.assetName} reported ${shareFact.value} weighted-average diluted shares outstanding for the quarter ended ${shareFact.end} in its ${shareFact.filed} 10-Q.`;
          await sql.begin(async (tx) => {
            const [existing] = await tx`
              SELECT id FROM evidence_claims
              WHERE research_run_id = ${ctx.runId} AND claim_text = ${claimText}
              LIMIT 1
            `;
            if (existing) return;
            const [claim] = await tx`
              INSERT INTO evidence_claims (
                asset_id, research_run_id, claim_text, claim_type, claim_category,
                polarity, period_start, period_end, as_of_date, confidence,
                generated_by, review_status, metadata_json
              ) VALUES (
                ${ctx.assetId}, ${ctx.runId}, ${claimText}, 'sec_fact', 'dilution',
                'neutral', ${shareFact.start}, ${shareFact.end}, ${shareFact.end}, 1,
                'system-research-os', 'accepted', ${tx.json({
                  source_document_id: String(primaryDoc.id),
                  accession_number: shareFact.accession_number,
                  concept: "WeightedAverageNumberOfDilutedSharesOutstanding",
                })}
              ) RETURNING id
            `;
            const [location] = await tx`
              INSERT INTO source_locations (
                source_document_id, document_parse_id, document_chunk_id,
                char_start, char_end, locator_json
              ) VALUES (
                ${primaryDoc.id}, ${chunk.document_parse_id}, ${chunk.id},
                ${chunk.char_start}, ${chunk.char_end},
                ${tx.json({ accession_number: shareFact.accession_number, concept: "WeightedAverageNumberOfDilutedSharesOutstanding" })}
              ) RETURNING id
            `;
            await tx`
              INSERT INTO evidence_links (evidence_claim_id, source_location_id, support_type, quoted_text, confidence)
              VALUES (${claim.id}, ${location.id}, 'supports', ${`"val": ${shareFact.value}`}, 1)
            `;
          });
        }
        if (equity && goodwill && intangibles && shares && shares.value > 0) {
          navInputs = {
            method: "tangible_book_nav",
            stockholders_equity_usd: equity.value,
            goodwill_usd: goodwill.value,
            intangible_assets_usd: intangibles.value,
            common_shares_outstanding: shares.value,
            tangible_book_value_per_share: Number(((equity.value - goodwill.value - intangibles.value) / shares.value).toFixed(6)),
            ...(reportedDilutedShares && reportedDilutedShares.value > 0 ? {
              reported_diluted_weighted_average_shares: reportedDilutedShares.value,
              tangible_book_value_per_diluted_share: Number(((equity.value - goodwill.value - intangibles.value) / reportedDilutedShares.value).toFixed(6)),
              diluted_shares_period_end: reportedDilutedShares.end,
            } : {}),
            balance_sheet_date: equity.end,
            shares_date: shares.end,
            source_document_id: String(primaryDoc.id),
            limitation: "Tangible book value is a balance-sheet cross-check, not liquidation value or a complete regulatory capital assessment.",
          };
        }
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
        current_market_snapshot: marketSnapshot,
        accepted_historical_metrics: metricRows,
        nav_inputs: navInputs,
        reported_diluted_shares: reportedDilutedShares,
        operating_model: upstream.operating_model || null,
        operating_scenarios: compactScenarios,
        forecast_reconciliation: upstream.top_down_bottom_up_reconciliation || null,
        reinvestment_model: upstream.reinvestment_model || null,
        valuation_method_protocol: {
          required_model_keys: navInputs ? ["driver_based_dcf", "tangible_book_nav"] : ["driver_based_dcf"],
        },
        output_schema: VALUATION_CONTRACT.schema,
      };
      const taskKey = "valuation-analyst:valuation";

      const promptFactory = (p: Record<string, unknown>) => exactJsonPrompt({
        agentName: "valuation-analyst",
        requiredKeys: VALUATION_CONTRACT.requiredKeys,
        packet: p,
        extraRules: [
          "Execute valuation lenses appropriate to the asset profile.",
          "Use the valuation specialist's team_context.brief and the business specialist's accepted assumptions. Tailor the DCF to this investment's segments, customer economics, operating constraints, reinvestment and capital structure. Identify the supplied operating scenario and numeric assumption behind each cash-flow driver in source_notes. Do not substitute a generic revenue-growth template or silently change the business assumptions; flag missing inputs for specialist follow-up.",
          "Provide per-share valuation targets and probabilistic scenarios.",
          "Follow output_schema exactly, including every nested required field and primitive type.",
          "Supply method_inputs for multiple economically appropriate valuation methods, each with Bear, Base and Bull annual schedules. Use cash amounts and diluted shares in millions. Cash_flow must be FCFF for fcff, FCFE for fcfe, and dividends for dividend or equity exit methods. Choose FCFE, earnings exit, book or tangible-book exit for financial firms as appropriate; do not treat bank operating cash flow as FCFF. Terminal multiples use total earnings/equity, never per-share inputs. Rates are decimals. Explain source calibration, dilution, capital needs and the equity bridge. The application computes discount factors, terminal value and present value. Explain unsupported methods and missing inputs in omitted_methods; never fabricate data to fill a schedule.",
          "annual_price_target_path must include bear, base, and bull price targets for every fiscal year through terminal_year.",
          "Use the supplied operating-scenario financial statements, accepted historical metrics, cash, dilution, and current market price. Do not claim these inputs are absent when they are in the packet.",
          "Keep annual operating values, net margins, reinvestment, and terminal-year assumptions consistent with the supplied operating scenarios; explain any changed assumption in the relevant output object.",
          "For a pre-profit company, use scenario-appropriate revenue, cash/NAV, reverse-valuation, and dilution-aware methods when earnings or FCF multiples are not meaningful.",
          "All three terminal anchors and annual price targets must be positive finite per-share values. Preserve uncertainty through a wide bear/base/bull range rather than zero placeholders.",
          "When nav_inputs is supplied, include a separate tangible-book NAV cross-check in valuation_scenario_set and distinguish it from the forecast price targets.",
          "Use reported_diluted_shares as the minimum denominator for all forecast per-share values and price targets. State that future share issuance beyond the reported diluted count remains an uncertainty.",
          "Every annual projection balance_sheet_values must include diluted_shares_millions. If it also includes diluted_shares or shares_outstanding, those raw fields must be actual share counts, equal to the millions field times 1,000,000. Per-share dollar values are never in millions.",
        ],
      });

      const output = await callResearchAgent<Record<string, any>>({
        sql, ctx, stageKey: "asset_valuation", taskKey,
        taskType: "asset_valuation", agentName: "valuation-analyst", modelTier: "mid",
        packet, promptFactory,
        outputFormat: { ...VALUATION_CONTRACT, validate(value) {
          const errors = VALUATION_CONTRACT.validate?.(value) || [];
          if (errors.length || !reportedDilutedShares) return errors;
          return projectionShareUnitErrors((value as any).annual_price_target_path?.annual_projections || []);
        } },
      });

      const scenarioSet = output.valuation_scenario_set || {};
      const targetPath = output.annual_price_target_path || {};
      if (navInputs) {
        scenarioSet.nav_cross_check = navInputs;
      }
      const dilutedMillions = Number(reportedDilutedShares?.value) / 1e6;
      if (dilutedMillions > 0 && Array.isArray(targetPath.annual_projections)) {
        const scaleByYear = new Map<number, number>();
        for (const projection of targetPath.annual_projections) {
          const balance = projection.balance_sheet_values || {};
          const oldShares = projectionSharesInMillions(balance, dilutedMillions);
          const newShares = Math.max(oldShares, dilutedMillions);
          const scale = oldShares / newShares;
          scaleByYear.set(Number(projection.fiscal_year), scale);
          for (const [key, value] of Object.entries(balance)) {
            if (/per_share|bvps|eps/i.test(key) && typeof value === "number" && Number.isFinite(value)) {
              balance[key] = Number((value * scale).toFixed(6));
            } else if (/per_share|bvps|eps/i.test(key) && value && typeof value === "object") {
              for (const [scenario, amount] of Object.entries(value)) {
                if (typeof amount === "number" && Number.isFinite(amount)) {
                  (value as Record<string, number>)[scenario] = Number((amount * scale).toFixed(6));
                }
              }
            }
          }
          balance.shares_outstanding_millions = Number(newShares.toFixed(6));
          balance.diluted_shares_millions = Number(newShares.toFixed(6));
          for (const key of ["diluted_shares", "shares_outstanding"]) {
            if (balance[key] != null) balance[key] = Number((newShares * 1e6).toFixed(6));
          }
          for (const [key, value] of Object.entries(projection.per_share_values || {})) {
            if (typeof value === "number" && Number.isFinite(value)) {
              projection.per_share_values[key] = Number((value * scale).toFixed(6));
            }
          }
        }
        for (const row of Array.isArray(targetPath.price_target_path) ? targetPath.price_target_path : []) {
          const scale = scaleByYear.get(Number(row.fiscal_year));
          if (scale !== undefined) row.price_target = Number((Number(row.price_target) * scale).toFixed(6));
        }
        const terminalYear = Number(scenarioSet.terminal_year);
        for (const scenarioType of ["bear", "base", "bull"]) {
          const terminal = targetPath.price_target_path?.find(
            (row: any) => Number(row.fiscal_year) === terminalYear && row.scenario_type === scenarioType
          );
          if (terminal) scenarioSet[`terminal_anchor_${scenarioType}`] = terminal.price_target;
        }
        scenarioSet.dilution_assumption = {
          reported_diluted_weighted_average_shares: reportedDilutedShares!.value,
          reported_period_end: reportedDilutedShares!.end,
          source_accession_number: reportedDilutedShares!.accession_number,
          treatment: "Reported diluted shares are the minimum forecast denominator; further issuance is an unquantified source gap.",
        };
        scenarioSet.source_gaps = [
          ...(Array.isArray(scenarioSet.source_gaps) ? scenarioSet.source_gaps.filter((gap: unknown) => !/share dilution schedule|future share issuance/i.test(String(gap))) : []),
          "No sourced future share issuance schedule is available beyond the reported diluted share count.",
        ];
      }
      const marketPrice = Number(marketSnapshot.regular_market_price);
      if (marketPrice > 0) scenarioSet.current_market_price = marketPrice;
      const probabilities = [
        Number(compactScenarios.probability_bear),
        Number(compactScenarios.probability_base),
        Number(compactScenarios.probability_bull),
      ];
      const anchors = [
        Number(scenarioSet.terminal_anchor_bear),
        Number(scenarioSet.terminal_anchor_base),
        Number(scenarioSet.terminal_anchor_bull),
      ];
      if (probabilities.every(Number.isFinite) && anchors.every(Number.isFinite)
        && Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) < 0.001) {
        scenarioSet.probability_bear = probabilities[0];
        scenarioSet.probability_base = probabilities[1];
        scenarioSet.probability_bull = probabilities[2];
        scenarioSet.weighted_target = Number(anchors.reduce(
          (sum, anchor, index) => sum + anchor * probabilities[index], 0
        ).toFixed(6));
      }
      if (marketPrice > 0 && Array.isArray(targetPath.price_target_path)) {
        for (const row of targetPath.price_target_path) {
          const target = Number(row.price_target);
          const dividend = Number(row.dividend_per_share || 0);
          if (Number.isFinite(target) && Number.isFinite(dividend)) {
            row.total_return_target = Number(((target + dividend - marketPrice) / marketPrice).toFixed(6));
          }
        }
      }
      scenarioSet.methods = [...new Set([
        ...(Array.isArray(scenarioSet.methods) ? scenarioSet.methods : []),
        ...(Array.isArray(targetPath.price_target_path)
          ? targetPath.price_target_path.map((row: any) => String(row.valuation_method)).filter(Boolean)
          : []),
        ...(navInputs ? ["tangible_book_nav"] : []),
      ])];
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
            ...requiredLenses.map((lens) => ({
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
      output.valuation_scenario_set.method_schedules=(output.valuation_scenario_set.method_inputs??[]).map(calculateValuationSchedule);
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

      // Preserve the run-scoped module-attempt contract used by the profile
      // gate. The v3 valuation handler produces the consolidated artifacts in
      // one bounded call, so each required module is recorded as covered by
      // that completed valuation task.
      for (const moduleKey of requiredModules) {
        const moduleTask = await createV3Task(
          sql,
          ctx.runId,
          "asset_valuation",
          moduleKey,
          "profile_module",
          "valuation-analyst"
        );
        await completeV3Task(sql, moduleTask.id, {
          module_key: moduleKey,
          covered_by: "asset_valuation",
          pipeline_version: CURRENT_PIPELINE_VERSION,
        });
      }

      return output;
    } finally {
      await sql.end();
    }
  },
};
