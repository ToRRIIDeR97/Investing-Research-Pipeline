import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { callV3Agent, v3ExactJsonPrompt } from "../../v3-context";
import {
  loadAcceptedEvidencePacket,
  persistMetrics,
} from "../../system-pipeline";
import { buildHistoricalRecord } from "../../history/normalizer";
import { createArtifactRepository } from "../../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const NORMALIZER_OUTPUT_KEYS = [
  "normalized_observations",
  "definition_mappings",
  "conversion_notes",
  "unresolved_ambiguities",
  "quality_flags",
  "source_gaps",
];

export const historicalRecordHandler: V3StageHandler<unknown> = {
  stageKey: "historical_record",
  async execute(ctx: V3RunContext): Promise<unknown> {
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
        pipelineVersion: 3,
      };

      // 2. Load evidence claims
      const evidenceClaims = await loadAcceptedEvidencePacket(sql, v2Ctx);

      // 3. Call metric-normalizer agent
      const taskKey = "metric-normalizer:observations";
      let output = await sql`
        SELECT output_json FROM research_tasks
        WHERE research_run_id = ${ctx.runId} AND task_key = ${taskKey} AND status = 'completed'
      `.then(rows => rows[0]?.output_json as Record<string, any>);

      if (!output) {
        const packet = {
          asset: v2Ctx,
          evidence_claims: evidenceClaims,
          required_modules: v2Ctx.requiredModules,
        };
        const promptFactory = (packet: Record<string, unknown>) => v3ExactJsonPrompt({
          agentName: "metric-normalizer",
          requiredKeys: NORMALIZER_OUTPUT_KEYS,
          packet,
          extraRules: [
            "Normalize and standardize all numbers, currencies, units, and dates into canonical observations.",
            "Separate GAAP and non-GAAP measurements explicitly (use distinct metric_keys, e.g. net_revenue vs gross_revenue).",
            "Identify the latest restatement version where applicable.",
          ],
        });

        output = await callV3Agent<Record<string, unknown>>({
          sql, ctx, stageKey: "historical_record", taskKey,
          taskType: "metric_normalization", agentName: "metric-normalizer", modelTier: "cheap",
          packet, promptFactory,
        });
      }

      // Find primary source to link (fallback)
      const primaryDoc = await sql`
        SELECT id FROM source_documents WHERE research_run_id = ${ctx.runId} LIMIT 1
      `;
      const primarySourceId = primaryDoc[0]?.id || "00000000-0000-4000-8000-000000000001";

      // 4. Persist observations in metric_observations table
      await persistMetrics(sql, v2Ctx, primarySourceId, output);

      // 5. Fetch all observations from the DB and construct twenty-quarter HistoricalRecord
      const obsRows = await sql`
        SELECT mo.value_numeric, mo.period_start, mo.period_end, mo.unit, mo.currency, mo.confidence,
               md.metric_key, md.metric_category
        FROM metric_observations mo
        JOIN metric_definitions md ON md.id = mo.metric_definition_id
        WHERE mo.research_run_id = ${ctx.runId}
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
          reporting_basis: "gaap" as const, // Default
          metric_type: "reported" as const,
          value_numeric: row.value_numeric ? Number(row.value_numeric) : null,
          unit: String(row.unit || ""),
          currency: String(row.currency || "USD"),
          confidence: Number(row.confidence || 1),
          restatement_version: 0,
          comparability_status: "comparable" as const,
          metadata_json: {},
        };
      });

      // Find start/end periods
      const currentYear = new Date().getFullYear();
      const record = buildHistoricalRecord({
        asset_id: ctx.assetId,
        run_id: ctx.runId,
        observations,
        requiredMetricKeys: [...new Set(observations.map(o => o.metric_key))],
        endFiscalYear: currentYear - 1,
        endFiscalQuarter: 4,
      });

      // 6. Save artifact using repository
      const repo = createArtifactRepository(db);
      await repo.upsertArtifact({
        research_run_id: ctx.runId,
        asset_id: ctx.assetId,
        profile_id: ctx.profileId || undefined,
        artifact_type: "historical_record",
        scope_key: `${ctx.assetSlug}-historical-record`,
        status: "accepted",
        content_json: record as any,
        schema_version: "3.0.0",
        validator_version: "1.0.0",
        prompt_version: "v3",
        created_by: "system-v3",
        idempotency_key: `${ctx.runId}-historical-record`,
      });

      return {
        status: "success",
        observationsCount: observations.length,
        ttmSeriesCount: record.ttm_series.length,
      };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
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
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
