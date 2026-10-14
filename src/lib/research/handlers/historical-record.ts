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
import { captureMarketHistory } from '../history/market-history';
import { repairModuleWriter } from '../repair/agent';
import { HistoricalObservation } from '../history/contracts';
import { createArtifactRepository } from "../artifacts/repository";
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

      const observations = obsRows.map(row => {
        const start = row.period_start ? new Date(row.period_start) : null;
        const end = new Date(row.period_end);
        const diffMonth = start ? (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) : 3;
        const periodicity = diffMonth > 6 ? "annual" : "quarterly";
        const fiscal_quarter = periodicity === "annual" ? null : Math.floor(end.getMonth() / 3) + 1;

        return {
          metric_key: String(row.metric_key),
          fiscal_year: end.getFullYear(),
          fiscal_quarter,
          periodicity: periodicity as "annual" | "quarterly",
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
        };
      });

      // Find start/end periods
      let end = latestCompletedQuarter(ctx.marketDataCutoffAt || ctx.cutoffAt);
      // Period-end closes and market caps; missing prices never block the financial record.
      const marketHistory = await captureMarketHistory(sql, ctx, filings.observations)
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

      return {
        status: "success",
        observationsCount: observations.length,
        ttmSeriesCount: record.ttm_series.length,
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
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
