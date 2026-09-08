import { completeV3Task, createV3Task, failV3Task } from "../run-context";
import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { HISTORICAL_DIAGNOSIS_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { buildHistoricalDiagnosis } from "../diagnosis/diagnosis";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";

export const historicalDiagnosisHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "historical_diagnosis",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    let task: Awaited<ReturnType<typeof createV3Task>> | null = null;
    try {
      const observationRows = await sql`
        SELECT md.metric_key, mo.value_numeric, mo.period_end, mo.as_of_date,
               mo.confidence, mo.unit, mo.currency
        FROM metric_observations mo
        JOIN metric_definitions md ON md.id = mo.metric_definition_id
        WHERE mo.research_run_id = ${ctx.runId}
          AND mo.review_status = 'accepted'
          AND mo.value_numeric IS NOT NULL
          AND COALESCE(mo.period_end, mo.as_of_date) <= ${ctx.marketDataCutoffAt?.toISOString().slice(0, 10) || new Date().toISOString().slice(0, 10)}::date
          AND (mo.available_at IS NULL OR mo.available_at <= ${ctx.marketDataCutoffAt || new Date()})
        ORDER BY md.metric_key, COALESCE(mo.period_end, mo.as_of_date)
      `;
      const claimRows = await sql`
        SELECT id FROM evidence_claims
        WHERE research_run_id = ${ctx.runId}
          AND review_status IN ('machine_verified', 'accepted')
        ORDER BY created_at
      `;
      const fallbackClaimIds = claimRows.slice(0, 3).map((row) => String(row.id));
      if (fallbackClaimIds.length === 0) {
        throw new Error("Historical diagnosis requires at least one accepted evidence claim");
      }
      const taskKey = `historical-diagnostician:diagnosis:${createHash("sha256")
        .update(JSON.stringify({ observations: observationRows, evidence_claim_ids: fallbackClaimIds }))
        .digest("hex")
        .slice(0, 12)}`;
      task = await createV3Task(
        sql,
        ctx.runId,
        "historical_diagnosis",
        taskKey,
        "historical_diagnosis",
        "historical-diagnostician"
      );
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
        metricKeys.map((metricKey) => [metricKey, fallbackClaimIds])
      );
      const output: Record<string, any> = {
        historical_diagnosis: buildHistoricalDiagnosis({
          asset_id: ctx.assetId,
          run_id: ctx.runId,
          observations,
          materialMetricKeys: metricKeys,
          supportingClaims,
          endFiscalYear: new Date().getUTCFullYear(),
          endFiscalQuarter: 4,
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
      if (task) await failV3Task(sql, task.id, error).catch(() => undefined);
      throw error;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, _output: unknown): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const errors: string[] = [];
      const artifactKeys = HISTORICAL_DIAGNOSIS_CONTRACT.requiredKeys;
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
