import { completeV3Task, createV3Task, failV3Task } from "../run-context";
import type { ResearchRunContext, StageHandler } from "../run-context";
import { HISTORICAL_DIAGNOSIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { buildHistoricalDiagnosis } from "../diagnosis/diagnosis";
import { latestCompletedQuarter } from "../history/normalizer";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const historicalDiagnosisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "historical_diagnosis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    const taskKey = "historical-diagnostician:diagnosis";
    const task = await createV3Task(
      sql,
      ctx.runId,
      "historical_diagnosis",
      taskKey,
      "historical_diagnosis",
      "historical-diagnostician"
    );
    try {
      const observationRows = await sql`
        SELECT mo.id, md.metric_key, mo.value_numeric, mo.period_end, mo.as_of_date,
               ec.id AS evidence_claim_id,
               mo.confidence, mo.unit, mo.currency
        FROM metric_observations mo
        JOIN metric_definitions md ON md.id = mo.metric_definition_id
        LEFT JOIN evidence_claims ec ON ec.id = mo.evidence_claim_id AND ec.review_status = 'accepted'
        WHERE mo.research_run_id = ${ctx.runId}
          AND mo.review_status = 'accepted'
          AND mo.value_numeric IS NOT NULL
          AND mo.period_end <= ${(ctx.marketDataCutoffAt || ctx.cutoffAt).toISOString().slice(0, 10)}
          AND (mo.available_at IS NULL OR mo.available_at <= ${(ctx.marketDataCutoffAt || ctx.cutoffAt).toISOString()})
          AND (mo.period_start IS NULL OR mo.period_start >= date_trunc('quarter', mo.period_end::timestamp)::date)
        ORDER BY md.metric_key, COALESCE(mo.period_end, mo.as_of_date)
      `;
      const observations = observationRows.map((row) => {
        const date = new Date(row.period_end || row.as_of_date);
        return {
          metric_key: String(row.metric_key),
          fiscal_year: date.getUTCFullYear(),
          fiscal_quarter: Math.floor(date.getUTCMonth() / 3) + 1,
          periodicity: "quarterly" as const,
          reporting_basis: "gaap" as const,
          metric_type: "reported" as const,
          value_numeric: Number(row.value_numeric),
          unit: String(row.unit || ""),
          currency: String(row.currency || "USD"),
          confidence: Number(row.confidence || 0.7),
          restatement_version: 0,
          comparability_status: "comparable" as const,
          metadata_json: {},
        };
      });
      const metricKeys = [...new Set(observations.map((row) => row.metric_key))];
      const supportingClaims = Object.fromEntries(
        metricKeys.map((metricKey) => [metricKey, [...new Set(observationRows
          .filter(row => row.metric_key === metricKey && row.evidence_claim_id).map(row => String(row.evidence_claim_id))) ]])
      );
      const end = latestCompletedQuarter(ctx.marketDataCutoffAt || ctx.cutoffAt);
      const output: Record<string, any> = {
        historical_diagnosis: buildHistoricalDiagnosis({
          asset_id: ctx.assetId,
          run_id: ctx.runId,
          observations,
          materialMetricKeys: metricKeys,
          supportingClaims,
          supportingObservations: Object.fromEntries(metricKeys.map(metricKey => [metricKey,
            observationRows.filter(row => row.metric_key === metricKey).map(row => String(row.id))])),
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
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
      }

      await completeV3Task(sql, task.id, output);
      return output;
    } catch (error) {
      await failV3Task(sql, task.id, error);
      throw error;
    } finally {
      await sql.end();
    }
  },
};
