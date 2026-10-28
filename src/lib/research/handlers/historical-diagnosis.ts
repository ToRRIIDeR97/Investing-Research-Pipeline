import { completeV3Task, createV3Task, failV3Task } from "../run-context";
import type { ResearchRunContext, StageHandler } from "../run-context";
import { HISTORICAL_DIAGNOSIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { buildHistoricalDiagnosis } from "../diagnosis/diagnosis";
import { latestCompletedQuarter } from "../history/normalizer";
import { fiscalCalendar, fiscalLabel, fiscalPeriodsFromObservations } from "../history/fiscal-calendar";
import type { HistoricalObservation } from "../history/contracts";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type RecordRow = Record<string, any>;

/**
 * The quarterly series diagnosis reads, from the historical_record observations (filed statements first, so 20-F/6-K
 * filers are covered, then companyfacts and normalizer rows). Consolidated quarters only, available by the cutoff;
 * per metric one currency and reporting basis (the pair most rows share, the earlier row winning ties), and one value
 * per fiscal quarter (a row with a period start, then the latest restatement, else the first row).
 */
export function diagnosisObservations(rows: RecordRow[], cutoffDate: string): HistoricalObservation[] {
  const quarters = rows.filter((row) => row.periodicity === "quarterly" && !row.segment && !row.geography
    && Number.isInteger(row.fiscal_year) && Number.isInteger(row.fiscal_quarter)
    && typeof row.value_numeric === "number" && Number.isFinite(row.value_numeric)
    && (!row.available_at || String(row.available_at).slice(0, 10) <= cutoffDate));
  const basisKey = (row: RecordRow) => `${row.currency ?? ""}|${row.reporting_basis ?? ""}`;
  const counts = new Map<string, Map<string, number>>();
  for (const row of quarters) {
    const byBasis = counts.get(row.metric_key) ?? new Map<string, number>();
    byBasis.set(basisKey(row), (byBasis.get(basisKey(row)) ?? 0) + 1);
    counts.set(row.metric_key, byBasis);
  }
  const chosen = new Map([...counts].map(([metric, byBasis]) =>
    [metric, [...byBasis].reduce((best, entry) => entry[1] > best[1] ? entry : best)[0]]));
  const byPeriod = new Map<string, RecordRow>();
  for (const row of quarters) {
    if (basisKey(row) !== chosen.get(row.metric_key)) continue;
    const key = `${row.metric_key}|${row.fiscal_year}|${row.fiscal_quarter}`;
    const kept = byPeriod.get(key);
    // A row with a stated quarter duration beats an undated one, which may be an annual total placed on Q4.
    const rank = (r: RecordRow) => [r.period_start ? 1 : 0, Number(r.restatement_version || 0)];
    const [dated, version] = rank(row), [keptDated, keptVersion] = kept ? rank(kept) : [-1, -1];
    if (!kept || dated > keptDated || (dated === keptDated && version > keptVersion)) byPeriod.set(key, row);
  }
  return [...byPeriod.values()].map((row) => ({
    metric_key: String(row.metric_key),
    fiscal_year: row.fiscal_year,
    fiscal_quarter: row.fiscal_quarter,
    periodicity: "quarterly" as const,
    reporting_basis: row.reporting_basis ?? "as_reported",
    metric_type: row.metric_type ?? "reported",
    value_numeric: row.value_numeric,
    unit: row.unit ?? null,
    currency: row.currency ?? null,
    evidence_claim_id: row.evidence_claim_id ?? null,
    source_document_id: row.source_document_id ?? null,
    confidence: typeof row.confidence === "number" ? row.confidence : 1,
    restatement_version: Number(row.restatement_version || 0),
    comparability_status: row.comparability_status ?? "comparable",
    metadata_json: {},
  }));
}

export const historicalDiagnosisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "historical_diagnosis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    const taskKey = "historical-diagnostician:diagnosis";
    let task: { id: string } | null = null;
    try {
      task = await createV3Task(sql, ctx.runId, "historical_diagnosis", taskKey, "historical_diagnosis", "historical-diagnostician");
      const cutoff = ctx.marketDataCutoffAt || ctx.cutoffAt;
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      // The run's accepted metric observations: quarters by duration (fiscal quarters of 52/53-week, June or September
      // years need not align with calendar quarters) and balances.
      const observationRows = await sql`
        SELECT mo.id, md.metric_key, mo.value_numeric, mo.period_start, mo.period_end, mo.as_of_date, mo.available_at,
               ec.id AS evidence_claim_id, mo.confidence, mo.unit, mo.currency, mo.data_provider, mo.revision_number, mo.metadata_json
        FROM metric_observations mo
        JOIN metric_definitions md ON md.id = mo.metric_definition_id
        LEFT JOIN evidence_claims ec ON ec.id = mo.evidence_claim_id AND ec.review_status = 'accepted'
        WHERE mo.research_run_id = ${ctx.runId}
          AND mo.review_status = 'accepted'
          AND mo.value_numeric IS NOT NULL
          AND mo.period_end <= ${cutoffDate}
          AND (mo.available_at IS NULL OR mo.available_at <= ${cutoff.toISOString()})
          AND (mo.period_start IS NULL OR mo.period_end - mo.period_start BETWEEN 80 AND 100)
        ORDER BY md.metric_key, COALESCE(mo.period_end, mo.as_of_date)
      `;
      // Label quarters on the filings' fiscal calendar (financial_statement_set), as historical_record does.
      const [statementSet] = await sql`
        SELECT content_json->'observations' AS observations FROM research_artifacts
        WHERE research_run_id = ${ctx.runId} AND artifact_type = 'financial_statement_set' AND status IN ('validated', 'accepted')
        ORDER BY artifact_version DESC, created_at DESC LIMIT 1
      `;
      const fiscalPeriods = fiscalPeriodsFromObservations(Array.isArray(statementSet?.observations) ? statementSet.observations : []);
      const place = fiscalCalendar(fiscalPeriods);
      const isoDay = (value: unknown) => new Date(value as string).toISOString().slice(0, 10);
      const storedRows = observationRows.flatMap((row) => {
        // Every row here is a quarter or a balance, so its end alone places it.
        const label = fiscalLabel(null, isoDay(row.period_end || row.as_of_date), fiscalPeriods, place);
        if (!label) return [];
        return [{ ...label, metric_key: String(row.metric_key), value_numeric: Number(row.value_numeric),
          period_start: row.period_start ? isoDay(row.period_start) : null, available_at: row.available_at ? isoDay(row.available_at) : null,
          reporting_basis: row.data_provider === "sec_companyfacts" ? "gaap" : (row.metadata_json?.agent_output?.reporting_basis || "as_reported"),
          unit: row.unit ?? null, currency: row.currency || "USD", evidence_claim_id: row.evidence_claim_id ?? null,
          confidence: row.confidence === null ? 0.7 : Number(row.confidence), restatement_version: Number(row.revision_number || 0) }];
      });
      // historical_record merges the filed statements (10-Q/10-K and 20-F/6-K alike) with companyfacts and normalizer
      // rows; metric_observations alone has no quarters for an IFRS filer. Record rows come first, so they win ties.
      const [record] = await sql`
        SELECT content_json->'observations' AS observations FROM research_artifacts
        WHERE research_run_id = ${ctx.runId} AND artifact_type = 'historical_record' AND status IN ('validated', 'accepted')
        ORDER BY artifact_version DESC, created_at DESC LIMIT 1
      `;
      const observations = diagnosisObservations([...(Array.isArray(record?.observations) ? record.observations : []), ...storedRows], cutoffDate);
      const metricKeys = [...new Set(observations.map((row) => row.metric_key))];
      const supportingClaims = Object.fromEntries(
        metricKeys.map((metricKey) => [metricKey, [...new Set(observations
          .filter(row => row.metric_key === metricKey && row.evidence_claim_id).map(row => String(row.evidence_claim_id))) ]])
      );
      const latestPeriod = [...fiscalPeriods].sort((a, b) => b.end.localeCompare(a.end))[0];
      const end = latestPeriod ? { year: latestPeriod.fiscal_year, quarter: latestPeriod.fiscal_quarter }
        : latestCompletedQuarter(cutoff);
      const output: Record<string, any> = {
        historical_diagnosis: buildHistoricalDiagnosis({
          asset_id: ctx.assetId,
          run_id: ctx.runId,
          observations,
          materialMetricKeys: metricKeys,
          supportingClaims,
          supportingObservations: Object.fromEntries(metricKeys.map(metricKey => [metricKey,
            observationRows.filter((row) => row.metric_key === metricKey).map((row) => String(row.id))])),
          endFiscalYear: end.year,
          endFiscalQuarter: end.quarter,
        }),
      };

      // Persist generated sub-artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = HISTORICAL_DIAGNOSIS_CONTRACT.requiredKeys;
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

      await completeV3Task(sql, task.id, output);
      return output;
    } catch (error) {
      if (task) await failV3Task(sql, task.id, error);
      throw error;
    } finally {
      await sql.end();
    }
  },
};
