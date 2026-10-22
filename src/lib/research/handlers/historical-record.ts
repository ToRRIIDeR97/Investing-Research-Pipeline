import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import {
  loadAcceptedEvidencePacket,
  persistMetrics,
} from "../sources/corpus";
import { buildHistoricalRecord, latestCompletedQuarter } from "../history/normalizer";
import { secQuarterlyObservations } from "../history/sec-companyfacts";
import { captureFilingStatements } from '../history/filing-store';
import { captureMarketHistory, latestPriceHistorySync } from '../history/market-history';
import { repairModuleWriter } from '../repair/agent';
import { HistoricalObservation } from '../history/contracts';
import { fiscalCalendar, fiscalLabel, fiscalPeriodsFromObservations } from '../history/fiscal-calendar';
import { createArtifactRepository } from "../artifacts/repository";
import { BASE_INPUTS } from "../reporting/metric-catalogue";
import { mergeObservations } from "../reporting/data-views";
import { saveReportArtifact } from "../reporting/store";
import { FinancialAnalytics, buildFinancialAnalytics } from "../history/analytics";
import { buildStatementSummary } from "../history/statement-summary";
import { buildPeerBenchmark } from "../sources/peers";
import { buildDemandBackdrop } from "../sources/demand";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** persistMetrics keeps at most this many model rows. */
const MAX_NORMALIZED_OBSERVATIONS = 60;

export const NORMALIZER_RULES = [
  `Return at most ${MAX_NORMALIZED_OBSERVATIONS} normalized_observations, only for metrics absent from covered_metric_keys: filed statements and SEC companyfacts already supply those. Give uncovered_required_metrics first.`,
  "Normalize their numbers, currencies, units, and dates into canonical observations.",
  "Separate GAAP and non-GAAP measurements explicitly (use distinct metric_keys, e.g. net_revenue vs gross_revenue).",
  "Identify the latest restatement version where applicable.",
  "Each normalized observation must include period_end, source_id, and evidence_claim_id from its supporting evidence. Use ISO dates; reporting periods do not establish publication dates.",
];

/**
 * Metric keys the filed statements and companyfacts already supply, and the plan's required metric
 * families they leave uncovered. A family is covered by its own key, by a statement category
 * (income_statement, balance_sheet, cash_flow), or, for share_count, by any share-count fact.
 */
export function normalizerCoverage(required: string[], observations: Record<string, any>[]) {
  const covered = new Set<string>(), families = new Set<string>();
  for (const observation of observations) {
    if (observation.value_numeric === null || observation.value_numeric === undefined) continue;
    covered.add(String(observation.metric_key));
    const category = observation.metadata_json?.metric_category ?? observation.metric_category;
    if (category) families.add(String(category));
    if (observation.unit === "shares") families.add("share_count");
  }
  return { covered: [...covered].sort(), uncovered: required.filter((key) => !covered.has(key) && !families.has(key)) };
}

const NORMALIZER_OUTPUT_KEYS = [
  "normalized_observations",
  "definition_mappings",
  "conversion_notes",
  "unresolved_ambiguities",
  "quality_flags",
  "source_gaps",
];

/**
 * Peer and demand benchmarks beside the subject's own history: peers named in the approved framing through EDGAR,
 * and the home country's demand series. Network failures become gaps in the artifacts and never fail the stage.
 * Mock and test runs make no external fetch.
 */
async function saveExternalBenchmarks(sql: ReturnType<typeof postgres>, ctx: ResearchRunContext) {
  const offline = process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1";
  const cutoff = ctx.cutoffAt.toISOString().slice(0, 10);
  const named = Array.isArray(ctx.researchFraming?.named_peers) ? ctx.researchFraming!.named_peers as { name?: unknown; ticker?: unknown }[] : [];
  const requests = named.filter((p) => typeof p?.name === "string").map((p) => ({ name: String(p.name), ticker: typeof p.ticker === "string" ? p.ticker : undefined }));
  const [asset] = await sql`SELECT home_country FROM assets WHERE id = ${ctx.assetId}`;
  const offlineNote = (type: string) => ({ artifact_type: type, status: "offline", note: "Mock or test run: no external fetch.", peers: [], series: [], gaps: [] });
  const peers = offline ? offlineNote("peer_benchmark") : await buildPeerBenchmark(requests, cutoff)
    .catch((error) => ({ artifact_type: "peer_benchmark", status: "unavailable", peers: [], gaps: [{ name: "all", reason: String(error?.message ?? error).slice(0, 200) }] }));
  const demand = offline ? offlineNote("demand_backdrop") : await buildDemandBackdrop(asset?.home_country, cutoff);
  await saveReportArtifact(sql, ctx, "peer_benchmark", `${ctx.assetSlug}-peer-benchmark`, peers);
  await saveReportArtifact(sql, ctx, "demand_backdrop", `${ctx.assetSlug}-demand-backdrop`, demand);
}

export const historicalRecordHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "historical_record",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    const db = drizzle(sql, { schema });
    try {
      // 1. Build RunContext
      const v2Ctx = {
        runId: ctx.runId,
        runType: ctx.runType,
        assetId: ctx.assetId,
        assetName: ctx.assetName,
        assetSlug: ctx.assetSlug,
        symbol: ctx.symbol,
        profileId: ctx.profileId || "",
        profileKey: ctx.profileKey || "",
        requiredModules: ctx.composedProfile?.required_artifacts.map((a: any) => a.artifact_type) || [],
        requiredLenses: ctx.composedProfile?.valuation_methods.map((m: any) => m.method) || [],
        marketDataCutoffAt: ctx.marketDataCutoffAt ? ctx.marketDataCutoffAt.toISOString() : null,
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      };

      // 2. Load evidence claims
      const evidenceClaims = await loadAcceptedEvidencePacket(sql, v2Ctx);

      // Find primary source to link (fallback)
      const primaryDoc = await sql`
        SELECT d.id, d.storage_path
        FROM source_documents d
        JOIN research_run_sources r ON r.source_document_id = d.id
        WHERE r.research_run_id = ${ctx.runId} AND d.source_type = 'primary_source_context'
        LIMIT 1
      `;
      if (!primaryDoc[0]) throw new Error("Primary source context is missing");
      const primarySourceId = String(primaryDoc[0].id);

      // The stored SEC file carries a full point-in-time series; model-extracted
      // claims alone usually cover only the latest quarter.
      const sourceRoot = resolve(process.cwd(), "storage", "sources");
      const sourcePath = resolve(process.cwd(), String(primaryDoc[0].storage_path));
      if (!sourcePath.startsWith(sourceRoot + sep)) throw new Error("Invalid primary source path");
      const secContext = JSON.parse(await readFile(sourcePath, "utf8"));
      const secFacts = secQuarterlyObservations(secContext.companyFacts, ctx.marketDataCutoffAt || ctx.cutoffAt);
      const [planRow] = await sql`
        SELECT content_json->'required_historical_metrics' AS metrics
        FROM research_artifacts
        WHERE research_run_id = ${ctx.runId} AND artifact_type = 'research_plan'
        ORDER BY created_at DESC LIMIT 1
      `;
      const plannedMetrics = Array.isArray(planRow?.metrics) ? planRow.metrics : [];
      const requiredMetricKeys = [...new Set(plannedMetrics
        .filter((metric: any) => metric.required === true && typeof metric.metric_family === "string")
        .map((metric: any) => metric.metric_family === "deposit_base" ? "deposits" : metric.metric_family))] as string[];
      // Filed statements come first: incomplete statements stop the stage before any normalizer call.
      const filings = await captureFilingStatements(sql, ctx, { writeModule: repairModuleWriter(sql, ctx) });
      if(filings.failures.length||filings.coverage.some(c=>c.status==='incomplete')||filings.reconciliation.some(c=>c.status==='mismatch'))throw new Error('Primary financial statements are incomplete or do not reconcile. Inspect financial_statement_set coverage before continuing.'+
        (filings.repair?` Repair specialist: ${filings.repair.status} after ${filings.repair.attempts} attempt(s)${filings.repair.last_errors.length?`; last errors: ${filings.repair.last_errors.slice(0,3).join('; ')}`:''}.`:''));
      // A foreign issuer has no 10-Qs: its quarters come from 6-K results releases, and fewer than 12 is not a history.
      const quarters = (filings as { quarter_coverage?: { quarters: number; first: string | null; last: string | null; minimum: number } }).quarter_coverage;
      if (quarters && quarters.quarters < quarters.minimum) throw new Error(`Foreign-issuer statements cover ${quarters.quarters} quarters (${quarters.first ?? "none"} to ${quarters.last ?? "none"}), below the ${quarters.minimum} needed; the 20-F and the stored 6-K results releases do not give a 20-quarter history.`);
      // The ADS ratio read from the release or 20-F fills the instrument's depositary_ratio, which the valuation needs
      // to put per-ordinary-share values on the per-ADS price. A ratio someone already set is kept.
      const depositary = (filings as { depositary_ratio?: { value: number } | null }).depositary_ratio;
      if (depositary?.value) await sql`UPDATE instruments SET depositary_ratio = ${depositary.value}, updated_at = NOW()
        WHERE asset_id = ${ctx.assetId} AND depositary_ratio IS NULL`;
      // 3. Call metric-normalizer agent, only for metrics the filings and companyfacts do not cover.
      const coverage = normalizerCoverage(requiredMetricKeys, [...filings.observations, ...secFacts]);
      const taskKey = "metric-normalizer:observations";

      const packet = {
        asset: v2Ctx,
        evidence_claims: evidenceClaims,
        required_modules: v2Ctx.requiredModules,
        covered_metric_keys: coverage.covered,
        uncovered_required_metrics: coverage.uncovered,
      };
      const promptFactory = (packet: Record<string, unknown>) => exactJsonPrompt({
        agentName: "metric-normalizer",
        requiredKeys: NORMALIZER_OUTPUT_KEYS,
        packet,
        extraRules: NORMALIZER_RULES,
      });

      // Every required metric already covered: the call would only restate filed numbers.
      const output: Record<string, unknown> = requiredMetricKeys.length && !coverage.uncovered.length && secFacts.length
        ? { ...Object.fromEntries(NORMALIZER_OUTPUT_KEYS.map((key) => [key, []])), skipped: "Filed statements and SEC companyfacts cover every required metric." }
        : await callResearchAgent<Record<string, unknown>>({
          sql, ctx, stageKey: "historical_record", taskKey,
          taskType: "metric_normalization", agentName: "metric-normalizer", modelTier: "cheap",
          packet, promptFactory,
        });

      // 4. Persist observations in metric_observations table
      await persistMetrics(sql, v2Ctx, primarySourceId, output, MAX_NORMALIZED_OBSERVATIONS);

      if (secFacts.length) {
        const filingRows = await sql`
          SELECT d.id, d.metadata_json->>'accessionNumber' AS accession_number
          FROM source_documents d
          JOIN research_run_sources r ON r.source_document_id = d.id
          WHERE r.research_run_id = ${ctx.runId}
            AND d.metadata_json->>'accessionNumber' IS NOT NULL
        `;
        const filingIds = new Map(filingRows.map((row) => [String(row.accession_number), String(row.id)]));
        await persistMetrics(sql, v2Ctx, primarySourceId, {
          normalized_observations: secFacts.map((fact) => ({
            ...fact,
            source_id: filingIds.get(fact.accession_number) || primarySourceId,
          })),
        }, 500);
      }

      // 5. Fetch all observations from the DB and construct twenty-quarter HistoricalRecord
      const obsRows = await sql`
        SELECT mo.value_numeric, mo.period_start, mo.period_end, mo.unit, mo.currency, mo.confidence,
               mo.source_document_id, mo.evidence_claim_id, mo.available_at, mo.data_provider,
               mo.revision_number, mo.metadata_json, md.metric_key, md.metric_category
        FROM metric_observations mo
        JOIN metric_definitions md ON md.id = mo.metric_definition_id
        WHERE mo.research_run_id = ${ctx.runId}
          AND mo.review_status = 'accepted'
          AND mo.period_end <= ${(ctx.marketDataCutoffAt || ctx.cutoffAt).toISOString().slice(0, 10)}
          AND (mo.available_at IS NULL OR mo.available_at <= ${(ctx.marketDataCutoffAt || ctx.cutoffAt).toISOString()})
      `;

      // Companyfacts and model rows carry dates only; label them on the filings' fiscal calendar so they
      // merge with filing rows of the same fiscal period (a June fiscal year's Jul-Sep quarter is Q1).
      const fiscalPeriods = fiscalPeriodsFromObservations(filings.observations);
      const place = fiscalCalendar(fiscalPeriods);
      const observations = obsRows.flatMap(row => {
        const label = fiscalLabel(row.period_start ? new Date(row.period_start).toISOString().slice(0, 10) : null,
          new Date(row.period_end).toISOString().slice(0, 10), fiscalPeriods, place);
        if (!label) return [];
        return [{
          metric_key: String(row.metric_key),
          ...label,
          reporting_basis: (row.data_provider === "sec_companyfacts" ? "gaap" : (row.metadata_json?.agent_output?.reporting_basis || "as_reported")) as "gaap" | "as_reported",
          metric_type: (row.metadata_json?.agent_output?.formula_or_adjustment ? "calculated" : "reported") as "calculated" | "reported",
          value_numeric: row.value_numeric !== null ? Number(row.value_numeric) : null,
          unit: String(row.unit || ""),
          currency: String(row.currency || "USD"),
          confidence: Number(row.confidence || 1),
          source_document_id: row.source_document_id,
          evidence_claim_id: row.evidence_claim_id,
          available_at: row.available_at ? new Date(row.available_at).toISOString().slice(0, 10) : null,
          restatement_version: Number(row.revision_number || 0),
          comparability_status: "comparable" as const,
          metadata_json: { ...(row.metadata_json || {}), metric_category: row.metric_category },
        }];
      });

      // Find start/end periods
      let end = latestCompletedQuarter(ctx.marketDataCutoffAt || ctx.cutoffAt);
      // Period-end closes and market caps; missing prices never block the financial record.
      // Source discovery's price sync summary says whether the Stooq cross-check ran.
      const marketHistory = await captureMarketHistory(sql, ctx, filings.observations, await latestPriceHistorySync(sql, ctx.runId))
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      const latestFiling=[...filings.tables].sort((a,b)=>b.period_end.localeCompare(a.period_end))[0];
      if(latestFiling?.fiscal_year&&latestFiling?.fiscal_quarter)end={year:latestFiling.fiscal_year,quarter:latestFiling.fiscal_quarter};
      const filingObservations = filings.observations.map(row => HistoricalObservation.parse(row));
      const observationKey=(row:Record<string,any>)=>JSON.stringify([row.metric_key,row.periodicity,row.fiscal_year,row.fiscal_quarter,row.unit,row.currency,row.reporting_basis,row.segment??'',row.geography??'']);
      const filingKeys = new Set(filingObservations.map(observationKey));
      const record = buildHistoricalRecord({
        asset_id: ctx.assetId,
        run_id: ctx.runId,
        observations: [...filingObservations, ...observations.filter(row => !filingKeys.has(observationKey(row)))],
        requiredMetricKeys: requiredMetricKeys.length ? requiredMetricKeys : [...new Set(observations.map(o => o.metric_key))],
        endFiscalYear: end.year,
        endFiscalQuarter: end.quarter,
      });

      // 6. Save artifact using repository
      const repo = createArtifactRepository(db);
      await repo.upsertArtifact({
        research_run_id: ctx.runId,
        asset_id: ctx.assetId,
        profile_id: ctx.profileId || undefined,
        artifact_type: "historical_record",
        scope_key: `${ctx.assetSlug}-historical-record`,
        status: "validated",
        content_json: { artifact_type: "historical_record", ...record } as any,
        schema_version: "3.0.0",
        validator_version: "1.0.0",
        prompt_version: "current",
        created_by: "system-research-os",
      });

      // The analytics pack and the statement summary are what later stages read instead of raw observations.
      const analytics = FinancialAnalytics.parse(buildFinancialAnalytics({
        observations: mergeObservations(filings.observations, record.observations, "error" in marketHistory ? [] : marketHistory.observations),
        endFiscalYear: end.year, endFiscalQuarter: end.quarter,
      }));
      await saveReportArtifact(sql, ctx, "financial_analytics", `${ctx.assetSlug}-financial-analytics`, analytics);
      const window = analytics.quarterly.rows.map((row) => String(row[0]));
      await saveReportArtifact(sql, ctx, "financial_statement_summary", `${ctx.assetSlug}-financial-statement-summary`, buildStatementSummary(filings, window));
      await saveExternalBenchmarks(sql, ctx);

      return {
        status: "success",
        observationsCount: observations.length,
        ttmSeriesCount: record.ttm_series.length,
        analyticsStatistics: analytics.statistics.rows.length,
        filingTableCount: filings.tables.length,
        filingCoverage: filings.coverage,
        marketHistory: "error" in marketHistory ? marketHistory
          : { observations: marketHistory.observations.length, barsAvailable: marketHistory.bars_available, crossCheck: marketHistory.cross_check },
      };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT COUNT(*) as cnt FROM metric_observations
        WHERE research_run_id = ${ctx.runId}
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No metric observations recorded for this run");
      }
      // Regression guard (RQ-EVAL-3): a record with three years of consolidated revenue must carry its TTM series.
      const [record] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${ctx.runId}
        AND artifact_type = 'historical_record' AND status IN ('validated', 'accepted') ORDER BY created_at DESC LIMIT 1`;
      const content = record?.content_json ?? {};
      const revenueKeys = BASE_INPUTS.revenue.aliases;
      const quarters = (content.observations ?? []).filter((o: any) => revenueKeys.includes(o.metric_key) && o.periodicity === "quarterly"
        && !o.segment && !o.geography && o.value_numeric !== null).length;
      if (quarters >= 12 && !(content.ttm_series ?? []).some((o: any) => revenueKeys.includes(o.metric_key))) {
        errors.push(`historical_record holds ${quarters} quarterly revenue observations but no TTM revenue series`);
      }
      const [analytics] = await sql`SELECT 1 FROM research_artifacts WHERE research_run_id = ${ctx.runId}
        AND artifact_type = 'financial_analytics' AND status IN ('validated', 'accepted') LIMIT 1`;
      if (quarters && !analytics) errors.push("financial_analytics was not saved");
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
