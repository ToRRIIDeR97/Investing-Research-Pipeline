import { completeV3Task, createV3Task } from "../run-context";
import type { ResearchRunContext, StageHandler } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import { VALUATION_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod/v4";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { latestSecInstantFact, latestSecQuarterlyFact, secFactSpan } from "../history/sec-companyfacts";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { calculateValuationSchedule, cashFlowBuildErrors, validateMethodInputs, ValuationMethodInput } from "../valuation/schedules";
import { valuationDatePrice } from "@/lib/market-data/price-history";
import { costOfCapitalInputs } from "../valuation/cost-of-capital";
import { hasDepreciationInputs, valuationFinancialInputs } from "../valuation/financial-inputs";
import { ReverseValuation, withheldValuationReason } from "../valuation/contracts";
import {
  SCENARIOS, assembleValuation, buildFcffSchedule, buildScenarioStatements, equityBridge, forecastHorizon, historyRatios,
  impliedOperatingMargin, impliedRevenueGrowth, latestRiskFreeRate, operatingModelFirstYear, valuationAssumptionsFormat,
  valuationReadiness, type Scenario, type ValuationAssumptionsOutput, type YearlyDriver,
} from "../valuation/engine";

/** Shared by both valuation prompts: anchor discount rates on the sourced beta and equity risk premium. */
const COST_OF_CAPITAL_RULE = "cost_of_capital_inputs holds a regression beta against the S&P 500 (beta), a dated implied equity risk premium (equity_risk_premium) and the CAPM cost of equity they give with risk_free_rate (capm_cost_of_equity). Build each discount rate from them, cite their values and as-of dates in rationale, and explain any departure from the CAPM rate. Flag an input marked unverified or stale; when one is null, say so and state the assumption used instead.";

/** The valuation analyst prompt for FCFF assets: assumptions only. Rules precede the packet so the packet stays last. */
export const valuationPrompt = (p: Record<string, unknown>) => exactJsonPrompt({
  agentName: "valuation-analyst",
  requiredKeys: ["valuation_assumptions"],
  packet: p,
  extraRules: [
    "The application builds each scenario's yearly statements and FCFF schedule from the operating scenarios' yearly_drivers and history_ratios (shown in scenario_statements), then computes the DCF, the yearly value per share, the scenario anchors, the weighted target, the returns and the reverse valuation. Supply only valuation_assumptions.",
    "For each of bear, base and bull give discount_rate, terminal and rationale. discount_rate is a decimal cost of capital for free cash flow to the firm and must exceed risk_free_rate.rate, the 10-year Treasury yield on risk_free_rate.observation_date; state the premium over it in rationale.",
    COST_OF_CAPITAL_RULE,
    "terminal is {\"type\": \"multiple\", \"metric\": \"nopat\", \"multiple\": x} applied to the final year's NOPAT, or {\"type\": \"perpetuity\", \"growth_rate\": g} with g below the discount rate. Calibrate it to each scenario's growth, margins and reinvestment in scenario_statements.",
    "Use the valuation specialist's team_context.brief. Do not return statements, schedules or per-share values and do not change the scenario drivers; note any disagreement with them in source_notes.",
    "Name the sources and calibration behind each rate in source_notes. List methods you judged inappropriate for this company, with the reason, in omitted_methods.",
    "Follow output_schema exactly.",
  ],
});

/** Banks and other assets valued on equity cash flows or book value: the model builds the schedules, code assembles them. */
const EquityMethodsOutput = z.object({
  valuation_scenario_set: z.object({
    artifact_type: z.literal("valuation_scenario_set"),
    valuation_status: z.enum(["complete", "withheld"]),
    method_inputs: z.array(ValuationMethodInput),
    omitted_methods: z.array(z.object({ method: z.string().min(1), reason: z.string().min(1) })),
    withheld_reason: z.string().optional(),
  }),
  reverse_valuation: ReverseValuation,
});
const METHOD_ORDER = ValuationMethodInput.shape.method.options;

/** The three schedules of the first method (in METHOD_ORDER) that has all of them; the path is assembled from it. */
export function primarySchedules(models: ValuationMethodInput[]): Record<Scenario, ValuationMethodInput> | null {
  for (const method of METHOD_ORDER) {
    const found = SCENARIOS.map((scenario) => models.find((model) => model.method === method && model.scenario_type === scenario));
    if (found.every(Boolean)) return Object.fromEntries(SCENARIOS.map((scenario, i) => [scenario, found[i]])) as Record<Scenario, ValuationMethodInput>;
  }
  return null;
}

export function equityMethodsFormat(options: { requireDepreciationAddBack: boolean }): AgentOutputFormat {
  return {
    requiredKeys: Object.keys(EquityMethodsOutput.shape),
    schema: z.toJSONSchema(EquityMethodsOutput, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>,
    validate(value) {
      const parsed = EquityMethodsOutput.safeParse(value);
      if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      const set = parsed.data.valuation_scenario_set;
      if (set.valuation_status === "withheld") {
        return set.withheld_reason?.trim() ? [] : [{ path: "valuation_scenario_set.withheld_reason", message: "Name the missing packet inputs when the valuation is withheld." }];
      }
      const errors = options.requireDepreciationAddBack ? cashFlowBuildErrors(set.method_inputs) : [];
      try {
        validateMethodInputs(set.method_inputs);
        const primary = primarySchedules(set.method_inputs);
        if (!primary) throw new Error("Provide Bear, Base and Bull schedules for at least one method.");
        assembleValuation({ schedules: primary, probabilities: {}, marketPrice: null, currency: primary.base.currency });
      } catch (error) {
        errors.push({ path: "valuation_scenario_set.method_inputs", message: error instanceof Error ? error.message : String(error) });
      }
      return errors;
    },
  };
}

export const equityMethodsPrompt = (p: Record<string, unknown>) => exactJsonPrompt({
  agentName: "valuation-analyst",
  requiredKeys: Object.keys(EquityMethodsOutput.shape),
  packet: p,
  extraRules: [
    "Use the valuation specialist's team_context.brief and the business specialist's accepted assumptions. Identify the supplied operating scenario and numeric assumption behind each cash-flow driver in source_notes. Do not silently change the business assumptions; flag missing inputs for specialist follow-up.",
    "Follow output_schema exactly, including every nested required field and primitive type.",
    "Supply method_inputs for economically appropriate equity methods, each with Bear, Base and Bull annual schedules over the same fiscal years. Choose FCFE, dividend, earnings exit, book or tangible-book exit for financial firms; do not treat bank operating cash flow as FCFF. Use cash amounts and diluted shares in millions. Terminal multiples use total earnings or equity, never per-share inputs. Rates are decimals; a cost of equity must exceed risk_free_rate.rate. Equity methods use equity_bridge 0.",
    `The application computes discount factors, terminal values, the yearly value per share, the scenario anchors, the weighted target and the returns from the first method in the order ${METHOD_ORDER.join(", ")}; other methods are cross-checks. Explain unsupported methods in omitted_methods; never fabricate data to fill a schedule.`,
    "Use financial_inputs (captured quarterly and annual revenue, costs, tax, D&A, SBC, operating cash flow, capex, cash, marketable securities, debt, leases, diluted shares, headcount, period-end closes and market caps), the operating scenarios, accepted historical metrics and the current market price. Check financial_inputs.columns and not_captured before listing a gap; never call a supplied input absent.",
    "For fcfe, give every year a build: starting_profit (net income), depreciation_amortization added back, capital_expenditures as a positive amount that is subtracted, change_in_net_working_capital, and other_adjustments (net borrowing; stock-based compensation when treated as a cash cost). cash_flow must equal the build.",
    "Discount rates, terminal growth and multiples are analyst assumptions: state each one and its rationale in source_notes rather than treating it as a missing input.",
    COST_OF_CAPITAL_RULE,
    "reverse_valuation gives the revenue growth and operating margin the current market price implies.",
    "Withhold only when no method can be built from the packet: then set valuation_status to \"withheld\", method_inputs to [] and withheld_reason naming the missing packet inputs. Otherwise set valuation_status to \"complete\".",
    "reported_diluted_shares.value is a share count; that count divided by 1,000,000 is the minimum diluted_shares, and the application raises any lower count to it.",
  ],
});

/**
 * The run's market snapshot as the valuation may use it. The snapshot is always a live fetch, so when it
 * was fetched more than a day after the cutoff (a historical run) its live price and 52-week range describe
 * a later market: they are dropped, and there is no fallback price.
 */
export function valuationMarketSnapshot(text: string, cutoff: Date): { snapshot: Record<string, unknown>; historical: boolean; fallbackPrice: number | null } {
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  const meta = parsed?.meta || {};
  const retrieved = Date.parse(String(parsed?.retrieved_at ?? ""));
  const historical = Number.isFinite(retrieved) && retrieved > cutoff.getTime() + 86_400_000;
  if (historical) return { historical, fallbackPrice: null, snapshot: { retrieved_at: parsed.retrieved_at, currency: meta.currency,
    live_fields_omitted: "Fetched after the market-data cutoff; the live price and 52-week range are not used." } };
  const price = Number(meta.regularMarketPrice);
  return { historical, fallbackPrice: price > 0 ? price : null, snapshot: {
    retrieved_at: parsed?.retrieved_at, currency: meta.currency, regular_market_price: meta.regularMarketPrice,
    fifty_two_week_high: meta.fiftyTwoWeekHigh, fifty_two_week_low: meta.fiftyTwoWeekLow,
  } };
}

/** Withheld artifacts: zero anchors and markers, never price targets. */
function withheldValuation(reason: string, horizon: number[], currency: string) {
  const status = { valuation_status: "withheld", withheld_reason: reason };
  const year = horizon.at(-1)!;
  return {
    valuation_scenario_set: {
      artifact_type: "valuation_scenario_set", terminal_year: year, terminal_anchor_bear: 0, terminal_anchor_base: 0, terminal_anchor_bull: 0,
      uses_adjusted_fcf: true, segments_reconciled: true, method_inputs: [], omitted_methods: [{ method: "all", reason }], ...status,
    },
    reverse_valuation: { artifact_type: "reverse_valuation", implied_growth: null, implied_margin: null, ...status },
    annual_price_target_path: {
      artifact_type: "annual_price_target_path", currency, market_price_currency: currency,
      annual_projections: [{ fiscal_year: year, target_date: `${year}-12-31`, operating_values: {}, balance_sheet_values: {}, per_share_values: {} }],
      price_target_path: SCENARIOS.map((scenario_type) => ({
        fiscal_year: year, scenario_type, valuation_method: "withheld", operating_metric_key: "withheld", operating_metric_value: 0,
        valuation_parameter_key: "withheld", valuation_parameter_value: 0, price_target: 0, dividend_per_share: 0, total_return_target: 0, is_interpolated: false,
      })),
      ...status,
    },
  } as Record<string, any>;
}

const pct = (value: number | null) => (value === null ? "not captured" : `${(value * 100).toFixed(1)}%`);
const rounded = (row: Record<string, number>) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key, key === "fiscal_year" ? value : Number(value.toFixed(/rate|margin|growth/.test(key) ? 4 : 1))]));

type ValuationSignalRow = {
  signal_key: string; signal_name: string; lens_family: string; current_value_text: string | null;
  comparison_range_json: Record<string, unknown>; signal: string; cheapness_score: number | null; confidence: number | null;
};

/**
 * Write this attempt's valuation_signals (consumed by the workflow gate, exports and the signal chart).
 * Signals an earlier attempt wrote under keys this attempt no longer produces are deleted.
 */
export async function persistValuationSignals(sql: ReturnType<typeof postgres>,
  ctx: Pick<ResearchRunContext, "runId" | "assetId" | "profileId">, signals: ValuationSignalRow[]) {
  await sql`
    DELETE FROM valuation_signals
    WHERE research_run_id = ${ctx.runId} AND signal_key <> ALL(${signals.map((sig) => sig.signal_key)}::text[])
  `;
  for (const sig of signals) {
    const updated = await sql`
      UPDATE valuation_signals
      SET signal_name = ${sig.signal_name}, lens_family = ${sig.lens_family},
          current_value_text = ${sig.current_value_text || null},
          comparison_range_json = ${sql.json((sig.comparison_range_json || {}) as any)},
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
        ${sig.current_value_text || null}, ${sql.json((sig.comparison_range_json || {}) as any)},
        ${sig.signal}, ${sig.cheapness_score || null}, ${sig.confidence || null}, 'accepted'
      WHERE NOT EXISTS (
        SELECT 1 FROM valuation_signals
        WHERE research_run_id = ${ctx.runId} AND signal_key = ${sig.signal_key}
      )
    `;
  }
}

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
      const scenarioList: any[] = Array.isArray(scenarioSetInput.scenarios) ? scenarioSetInput.scenarios : [];
      const probabilities = {
        probability_bear: scenarioSetInput.probability_bear,
        probability_base: scenarioSetInput.probability_base,
        probability_bull: scenarioSetInput.probability_bull,
      };
      const cutoff = ctx.marketDataCutoffAt || ctx.cutoffAt;
      // Captured statements and period-end prices, reduced to a compact table.
      const capturedRows = await sql`
        SELECT artifact_type, content_json->'observations' AS observations, content_json->'cross_check' AS cross_check,
          content_json->'beta' AS beta
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('financial_statement_set', 'market_price_history')
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type, created_at DESC
      `;
      const captured = (type: string) => capturedRows.find((row) => row.artifact_type === type);
      const financialInputs = valuationFinancialInputs({
        statementObservations: Array.isArray(captured("financial_statement_set")?.observations) ? captured("financial_statement_set")!.observations : [],
        marketObservations: Array.isArray(captured("market_price_history")?.observations) ? captured("market_price_history")!.observations : [],
        marketCrossCheck: captured("market_price_history")?.cross_check ?? null,
        cutoff,
      });
      const requireDepreciationAddBack = hasDepreciationInputs(financialInputs);
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
      const snapshot = valuationMarketSnapshot(String(marketRow?.text || "{}"), cutoff);
      let marketSnapshot = snapshot.snapshot;
      // Prefer the stored close on the valuation date (cutoff-consistent, cross-checked when possible).
      // Only a run valued as of its fetch date may fall back to the snapshot's live price.
      const valuationPrice = await valuationDatePrice(sql, ctx.assetId, ctx.symbol, cutoff)
        .catch(() => null);
      const priceWithheld = snapshot.historical && !valuationPrice
        ? `no stored close on or before the ${cutoff.toISOString().slice(0, 10)} cutoff, and the market snapshot was fetched after it` : null;
      if (valuationPrice) {
        marketSnapshot = {
          ...marketSnapshot,
          valuation_date_price: valuationPrice.price,
          valuation_date: valuationPrice.trading_date,
          valuation_price_currency: valuationPrice.currency,
          valuation_price_verified: valuationPrice.verified,
          valuation_price_verification_status: valuationPrice.verification_status,
        };
      }
      // The run's FRED DGS10 document supplies the risk-free rate on or before the cutoff.
      const [fred] = await sql`
        SELECT sd.id, string_agg(dc.text, '' ORDER BY dc.chunk_index) AS csv
        FROM research_run_sources rrs
        JOIN source_documents sd ON sd.id = rrs.source_document_id
        JOIN document_parses dp ON dp.source_document_id = sd.id AND dp.parser_name <> 'research-memory'
        JOIN document_chunks dc ON dc.document_parse_id = dp.id
        WHERE rrs.research_run_id = ${ctx.runId} AND sd.metadata_json->>'series_id' = 'DGS10'
        GROUP BY sd.id, sd.retrieved_at, dp.id
        ORDER BY sd.retrieved_at DESC
        LIMIT 1
      `;
      const riskFree = fred?.csv ? latestRiskFreeRate(String(fred.csv), cutoff.toISOString()) : null;
      const riskFreeRate = riskFree ? { ...riskFree, series_id: "DGS10", source: "FRED", source_document_id: String(fred.id) } : null;
      // Beta comes from the captured market_price_history; the ERP from the recorded reference value public by the cutoff.
      const costOfCapital = costOfCapitalInputs({ beta: captured("market_price_history")?.beta ?? null, riskFreeRate: riskFree, cutoffAt: cutoff });
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
        const fileText = await readFile(sourcePath, "utf8");
        const companyFacts = JSON.parse(fileText).companyFacts;
        const equity = latestSecInstantFact(companyFacts, "us-gaap", "StockholdersEquity", "USD", cutoff);
        const goodwill = latestSecInstantFact(companyFacts, "us-gaap", "Goodwill", "USD", cutoff);
        const intangibles = latestSecInstantFact(companyFacts, "us-gaap", "IntangibleAssetsNetExcludingGoodwill", "USD", cutoff);
        const shares = latestSecInstantFact(companyFacts, "dei", "EntityCommonStockSharesOutstanding", "shares", cutoff);
        reportedDilutedShares = latestSecQuarterlyFact(
          companyFacts, "us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", "shares", cutoff
        );
        if (reportedDilutedShares) {
          const shareFact = reportedDilutedShares;
          // Chunks are fixed slices of this file, so the fact's offset in the file selects the chunk(s)
          // holding it; a fact that straddles a chunk boundary is located across both.
          const span = secFactSpan(fileText, "WeightedAverageNumberOfDilutedSharesOutstanding", shareFact);
          const overlapping = span ? await sql`
            SELECT dc.id, dc.document_parse_id, dc.char_start, dc.char_end, dc.text
            FROM document_chunks dc
            JOIN document_parses dp ON dp.id = dc.document_parse_id AND dp.parser_name <> 'research-memory'
            WHERE dc.source_document_id = ${primaryDoc.id} AND dc.char_start < ${span.end} AND dc.char_end > ${span.start}
            ORDER BY dp.created_at DESC, dc.chunk_index
          ` : [];
          const chunks = overlapping.filter((row) => row.document_parse_id === overlapping[0]?.document_parse_id);
          const chunkStart = Number(chunks[0]?.char_start);
          if (!span || !chunks.length || chunks.map((row) => String(row.text)).join("")
            .slice(span.start - chunkStart, span.end - chunkStart) !== fileText.slice(span.start, span.end)) {
            throw new Error("SEC diluted-share fact could not be linked to its source chunk");
          }
          const chunk = { id: chunks[0].id, document_parse_id: chunks[0].document_parse_id, char_start: chunks[0].char_start, char_end: chunks.at(-1)!.char_end };
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

      // Shares are an input, never model-written: reported diluted shares, else the latest captured diluted count.
      const sharesAt = financialInputs?.columns.indexOf("diluted_shares") ?? -1;
      const capturedShares = sharesAt < 0 ? null : [...financialInputs!.annual, ...financialInputs!.quarterly]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map((row) => row[sharesAt]).filter((value): value is number => typeof value === "number" && value > 0).at(-1) ?? null;
      const dilutedMillions = reportedDilutedShares && reportedDilutedShares.value > 0 ? reportedDilutedShares.value / 1e6 : capturedShares;
      const marketPrice = Number(valuationPrice?.price ?? snapshot.fallbackPrice);
      const currency = financialInputs?.currency || String(valuationPrice?.currency || marketSnapshot.currency || "USD");
      const ratios = historyRatios(financialInputs);
      const baseYear = ratios.base_year?.fiscal_year ?? cutoff.getUTCFullYear() - 1;
      const horizon: number[] = Array.isArray(scenarioSetInput.forecast_horizon?.years) && scenarioSetInput.forecast_horizon.years.length
        ? scenarioSetInput.forecast_horizon.years.map(Number) : forecastHorizon(baseYear);
      const baseRow = [...(financialInputs?.annual ?? [])].reverse().find((row) => Number(row[1]) === baseYear);
      const fiscalYearEnd = baseRow ? String(baseRow[0]).slice(5) : undefined;
      const asset = { runId: ctx.runId, assetId: ctx.assetId, assetName: ctx.assetName, symbol: ctx.symbol, profileKey: ctx.profileKey };
      const equityMethods = ctx.archetypeKeys.includes("bank") || ctx.profileKey === "financials";
      const taskKey = "valuation-analyst:valuation";
      let output: Record<string, any>;

      if (priceWithheld) {
        // A historical run is never valued against a later market; nothing a model could judge would change that.
        output = withheldValuation(`Market price unavailable: ${priceWithheld}.`, horizon, currency);
      } else if (equityMethods) {
        // Banks: the model builds FCFE, dividend or book schedules; code assembles the path from the primary method.
        const metricRows = await sql`
          SELECT md.metric_key, mo.period_end, mo.value_numeric, mo.value_text, mo.unit, mo.currency
          FROM metric_observations mo
          JOIN metric_definitions md ON md.id = mo.metric_definition_id
          WHERE mo.research_run_id = ${ctx.runId}
            AND mo.review_status = 'accepted'
          ORDER BY mo.period_end DESC NULLS LAST, md.metric_key
          LIMIT 80
        `;
        const outputFormat = equityMethodsFormat({ requireDepreciationAddBack });
        const packet = {
          asset,
          required_lenses: requiredLenses,
          current_market_snapshot: marketSnapshot,
          risk_free_rate: riskFreeRate,
          cost_of_capital_inputs: costOfCapital,
          accepted_historical_metrics: metricRows,
          financial_inputs: financialInputs,
          nav_inputs: navInputs,
          reported_diluted_shares: reportedDilutedShares,
          operating_model: upstream.operating_model || null,
          operating_scenarios: { ...probabilities, scenarios: scenarioList.map((scenario) => ({
            scenario_type: scenario.scenario_type, numeric_assumptions: scenario.numeric_assumptions,
            yearly_drivers: scenario.yearly_drivers, resulting_financial_statements_json: scenario.resulting_financial_statements_json,
          })) },
          forecast_reconciliation: upstream.top_down_bottom_up_reconciliation || null,
          reinvestment_model: upstream.reinvestment_model || null,
          output_contract: "valuation_equity_methods",
          output_schema: outputFormat.schema,
        };
        const answer = await callResearchAgent<Record<string, any>>({
          sql, ctx, stageKey: "asset_valuation", taskKey,
          taskType: "asset_valuation", agentName: "valuation-analyst", modelTier: "premium",
          packet, promptFactory: equityMethodsPrompt, outputFormat,
        });
        const set = answer.valuation_scenario_set;
        if (set.valuation_status === "withheld") {
          output = withheldValuation(String(set.withheld_reason).trim(), horizon, currency);
        } else {
          const models: ValuationMethodInput[] = set.method_inputs.map((model: ValuationMethodInput) =>
            dilutedMillions && dilutedMillions > model.diluted_shares ? { ...model, diluted_shares: dilutedMillions } : model);
          const primary = primarySchedules(models)!;
          const assembled = assembleValuation({ schedules: primary, probabilities, marketPrice, currency: primary.base.currency, fiscalYearEnd });
          output = {
            valuation_scenario_set: { ...assembled.valuation_scenario_set, method_inputs: models, omitted_methods: set.omitted_methods, risk_free_rate: riskFreeRate,
              cost_of_capital_inputs: costOfCapital },
            annual_price_target_path: assembled.annual_price_target_path,
            reverse_valuation: answer.reverse_valuation,
          };
        }
      } else {
        const drivers = Object.fromEntries(SCENARIOS.map((scenario) => [scenario,
          scenarioList.find((entry) => entry.scenario_type === scenario)?.yearly_drivers])) as Record<Scenario, YearlyDriver[] | undefined>;
        const baseRevenue = ratios.base_year?.revenue ?? null;
        const readiness = valuationReadiness({ drivers, horizon, dilutedSharesMillions: dilutedMillions, marketPrice, baseRevenue });
        if (!readiness.ready) {
          // Nothing a model could judge is missing here; withhold without a call and name each input.
          output = withheldValuation(`Valuation inputs are missing: ${readiness.missing.join("; ")}.`, horizon, currency);
        } else {
          const statementInput = (scenario: Scenario) => ({
            baseRevenue: baseRevenue!, baseYear, ratios,
            drivers: drivers[scenario]!.filter((driver) => horizon.includes(driver.fiscal_year)),
          });
          const firstYear = operatingModelFirstYear(upstream.operating_model, baseRevenue);
          const statements = Object.fromEntries(SCENARIOS.map((scenario) => [scenario,
            buildScenarioStatements({ ...statementInput(scenario), firstYear: scenario === "base" ? firstYear : null })]));
          const bridge = equityBridge(financialInputs);
          const outputFormat = valuationAssumptionsFormat(riskFree?.rate ?? null);
          const packet = {
            asset,
            required_lenses: requiredLenses,
            current_market_snapshot: marketSnapshot,
            risk_free_rate: riskFreeRate,
            cost_of_capital_inputs: costOfCapital,
            financial_inputs: financialInputs,
            history_ratios: ratios,
            equity_bridge: bridge,
            diluted_shares_millions: dilutedMillions,
            operating_scenarios: { ...probabilities, scenarios: scenarioList.map((scenario) => ({
              scenario_type: scenario.scenario_type, yearly_drivers: scenario.yearly_drivers, numeric_assumptions: scenario.numeric_assumptions,
            })) },
            scenario_statements: Object.fromEntries(SCENARIOS.map((scenario) => [scenario, statements[scenario].map(rounded)])),
            operating_model: upstream.operating_model || null,
            reinvestment_model: upstream.reinvestment_model || null,
            output_contract: "valuation_assumptions",
            output_schema: outputFormat.schema,
          };
          const answer = (await callResearchAgent<Record<string, any>>({
            sql, ctx, stageKey: "asset_valuation", taskKey,
            taskType: "asset_valuation", agentName: "valuation-analyst", modelTier: "premium",
            packet, promptFactory: valuationPrompt, outputFormat,
          })).valuation_assumptions as ValuationAssumptionsOutput;
          const assumption = (scenario: Scenario) => answer.scenarios.find((entry) => entry.scenario_type === scenario)!;
          const sourceNotes = [
            `Statements built by code from operating_scenario_set yearly_drivers for FY${horizon[0]}-FY${horizon.at(-1)}${firstYear ? `; the base case's FY${horizon[0]} revenue and operating income come from operating_model` : ""}.`,
            `D&A ${pct(ratios.da_to_revenue)} and capex ${pct(ratios.capex_to_revenue)} of revenue (mean of the last ${Math.min(3, financialInputs?.annual.length ?? 0)} fiscal years in financial_inputs) unless a yearly driver overrides them; tax rate ${pct(ratios.tax_rate)} (${ratios.tax_rate_source}).`,
            riskFree ? `Risk-free rate ${riskFree.rate} on ${riskFree.observation_date} (FRED DGS10).` : "No FRED DGS10 observation was available by the cutoff.",
            ...(costOfCapital.capm_cost_of_equity ? [`CAPM cost of equity ${costOfCapital.capm_cost_of_equity.rate} = ${costOfCapital.capm_cost_of_equity.formula}.`] : []),
            ...(answer.source_notes ?? []),
          ];
          const bridgeExplanation = bridge
            ? `Latest balance sheet (${bridge.period_end}): ${Object.entries(bridge.components).map(([key, value]) => `${key.replace(/_/g, " ")} ${value}`).join(", ")}; cash and securities added, debt and leases subtracted.${bridge.missing.length ? ` Not captured: ${bridge.missing.join(", ")}.` : ""}`
            : "No cash, debt or lease balance was captured, so the equity bridge is 0.";
          const schedules = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, buildFcffSchedule({
            statements: statements[scenario], assumptions: assumption(scenario), bridge: bridge?.amount ?? 0,
            dilutedSharesMillions: dilutedMillions!, currency, sourceNotes, bridgeExplanation,
          })])) as Record<Scenario, ValuationMethodInput>;
          const assembled = assembleValuation({ schedules, probabilities, marketPrice, currency, fiscalYearEnd });
          const reverseInput = { ...statementInput("base"), assumptions: assumption("base"), bridge: bridge?.amount ?? 0, dilutedSharesMillions: dilutedMillions!, marketPrice };
          output = {
            valuation_scenario_set: {
              ...assembled.valuation_scenario_set, omitted_methods: answer.omitted_methods ?? [], risk_free_rate: riskFreeRate,
              cost_of_capital_inputs: costOfCapital,
              valuation_assumptions: answer, history_ratios: ratios,
              source_gaps: [
                ...(bridge?.missing.length ? [`Equity bridge items not captured: ${bridge.missing.join(", ")}.`] : bridge ? [] : ["No balance-sheet items were captured for the equity bridge."]),
                ...(ratios.tax_rate_source === "statutory_default" ? ["No captured tax history; NOPAT uses the 21% statutory rate."] : []),
                ...(riskFree ? [] : ["No FRED DGS10 observation was available by the cutoff; discount rates are unchecked against a risk-free rate."]),
                ...costOfCapital.gaps,
              ],
            },
            annual_price_target_path: assembled.annual_price_target_path,
            reverse_valuation: {
              artifact_type: "reverse_valuation", method: "fcff",
              implied_margin: impliedOperatingMargin(reverseInput), implied_growth: impliedRevenueGrowth(reverseInput), market_price: marketPrice,
              basis: `The uniform FY${horizon[0]}-FY${horizon.at(-1)} operating margin (with base revenue growth) and the uniform revenue growth (with base margins) at which the base FCFF value per share equals the market price, holding the base discount rate, terminal assumption, bridge and shares. null means no value in range reaches the price.`,
            },
          };
        }
      }

      // A non-positive code-built anchor cannot be a price target; record it as withheld rather than fail the stage.
      const built = output.valuation_scenario_set;
      const nonPositive = withheldValuationReason(built) ? [] : SCENARIOS.filter((scenario) => !(Number(built[`terminal_anchor_${scenario}`]) > 0));
      if (nonPositive.length) {
        output = withheldValuation(`The FY${built.terminal_year} value per share is not positive for ${nonPositive.map((scenario) =>
          `${scenario} (${Number(built[`terminal_anchor_${scenario}`]).toFixed(2)})`).join(", ")} under the supplied drivers and assumptions.`, horizon, currency);
      }
      const scenarioSet = output.valuation_scenario_set;
      const targetPath = output.annual_price_target_path;
      // A withheld valuation is recorded as such; no anchor is derived or invented for it.
      const withheldReason = withheldValuationReason(scenarioSet);
      if (navInputs) scenarioSet.nav_cross_check = navInputs;
      if (reportedDilutedShares) {
        scenarioSet.dilution_assumption = {
          reported_diluted_weighted_average_shares: reportedDilutedShares.value,
          reported_period_end: reportedDilutedShares.end,
          source_accession_number: reportedDilutedShares.accession_number,
          treatment: "Reported diluted shares are the minimum forecast denominator; further issuance is an unquantified source gap.",
        };
      }
      if (!withheldReason) {
        scenarioSet.source_gaps = [
          ...(Array.isArray(scenarioSet.source_gaps) ? scenarioSet.source_gaps : []),
          "No sourced future share issuance schedule is available beyond the reported diluted share count.",
          "No dividend forecast: dividend_per_share is 0 in every year.",
        ];
      }
      if (marketPrice > 0) {
        scenarioSet.current_market_price = marketPrice;
        scenarioSet.current_market_price_source = valuationPrice
          ? { provider: valuationPrice.provider, provider_symbol: valuationPrice.provider_symbol, trading_date: valuationPrice.trading_date,
              verified: valuationPrice.verified, verification_status: valuationPrice.verification_status, cross_check: valuationPrice.cross_check,
              source_url: valuationPrice.source_url, market_price_bar_id: valuationPrice.market_price_bar_id }
          : { provider: "yahoo_chart_snapshot", field: "regularMarketPrice", retrieved_at: marketSnapshot.retrieved_at ?? null, verified: false };
      }
      scenarioSet.methods = [...new Set([
        ...(Array.isArray(scenarioSet.methods) ? scenarioSet.methods : []),
        ...(navInputs ? ["tangible_book_nav"] : []),
      ])];
      const derivedScenarios = withheldReason ? [] : SCENARIOS.map((scenarioType) => ({
        scenario_name: `${scenarioType} valuation`,
        scenario_type: scenarioType,
        value_anchor: Number(scenarioSet[`terminal_anchor_${scenarioType}`]),
        assumptions_json: {
          terminal_year: scenarioSet.terminal_year,
          price_target_path: targetPath.price_target_path.filter((row: any) => row.scenario_type === scenarioType),
        },
        confidence: scenarioType === "base" ? 0.7 : 0.55,
      }));
      const baseAnchor = derivedScenarios.find((scenario) => scenario.scenario_type === "base")?.value_anchor;
      const comparisonRange = Object.fromEntries(
        derivedScenarios.map((scenario) => [scenario.scenario_type, scenario.value_anchor])
      );
      const withheldText = `Valuation withheld: ${withheldReason}`;
      const signals = withheldReason
        ? ["scenario_valuation", ...requiredLenses].map((lens) => ({
            signal_key: lens === "scenario_valuation" ? "scenario_price_target_range" : `${lens}_scenario_price_target`,
            signal_name: lens === "scenario_valuation" ? "Scenario price target range" : `${lens} scenario price target`,
            lens_family: lens,
            current_value_text: withheldText,
            comparison_range_json: {},
            signal: "not_applicable",
            cheapness_score: null,
            confidence: null,
          }))
        : [
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
          ];

      await persistValuationSignals(sql, ctx, signals);

      // Persist to scenarios table. A withheld valuation clears anchors left by an earlier attempt.
      if (withheldReason) {
        await sql`
          UPDATE scenarios SET value_anchor = NULL, assumptions_json = ${sql.json({ withheld_reason: withheldReason })}
          WHERE research_run_id = ${ctx.runId}
        `;
      }
      for (const scen of derivedScenarios) {
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
      scenarioSet.method_schedules = (scenarioSet.method_inputs ?? []).map(calculateValuationSchedule);
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      for (const k of VALUATION_CONTRACT.requiredKeys) {
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
