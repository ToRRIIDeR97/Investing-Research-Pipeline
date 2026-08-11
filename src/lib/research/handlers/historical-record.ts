import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";
import {
  loadAcceptedEvidencePacket,
  persistMetrics,
} from "../system-pipeline";
import { buildHistoricalRecord, isRecurringHistoricalObservation } from "../history/normalizer";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { createHash } from "node:crypto";

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
        requiredModules: ctx.composedProfile?.historical_metrics.map((metric: any) => metric.metric_family) || [],
        requiredLenses: ctx.composedProfile?.valuation_methods.map((m: any) => m.method) || [],
        marketDataCutoffAt: ctx.marketDataCutoffAt ? ctx.marketDataCutoffAt.toISOString() : null,
        pipelineVersion: CURRENT_PIPELINE_VERSION,
      };

      // 2. Load evidence claims
      const evidenceClaims = await loadAcceptedEvidencePacket(sql, v2Ctx);

      // 3. Call metric-normalizer agent
      const evidenceFingerprint = createHash("sha256")
        .update(JSON.stringify(evidenceClaims.map((claim) => ({
          id: claim.id,
          claim_text: claim.claim_text,
          as_of_date: claim.as_of_date,
          period_end: claim.period_end,
        }))))
        .digest("hex")
        .slice(0, 12);
      const taskKey = `metric-normalizer:observations:${evidenceFingerprint}`;
      let output = await sql`
        SELECT output_json FROM research_tasks
        WHERE research_run_id = ${ctx.runId} AND task_key = ${taskKey}
          AND status = 'completed' AND validation_status = 'valid'
      `.then(rows => rows[0]?.output_json as Record<string, any>);

      if (!output) {
        const packet = {
          asset: v2Ctx,
          evidence_claims: evidenceClaims,
          required_modules: v2Ctx.requiredModules,
        };
        const promptFactory = (packet: Record<string, unknown>) => exactJsonPrompt({
          agentName: "metric-normalizer",
          requiredKeys: NORMALIZER_OUTPUT_KEYS,
          packet,
          extraRules: [
            "Return only recurring quantitative financial or operating measurements. Dates, durations, transaction events, announcements, commitments, and founding milestones are evidence, not metric observations.",
            "Every normalized observation must contain a numeric value and period_end or as_of_date. Include period_start for flow metrics; use as_of_date for legitimate point-in-time balance-sheet metrics.",
            "Use required_modules as target metric families. Do not create an observation merely because an evidence claim contains a number.",
            "Separate GAAP and non-GAAP measurements explicitly (use distinct metric_keys, e.g. net_revenue vs gross_revenue).",
            "Identify the latest restatement version where applicable.",
          ],
        });

        output = await callResearchAgent<Record<string, unknown>>({
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

      // 4. Persist only recurring measurements; narrative events remain evidence claims.
      const normalizedObservations = Array.isArray(output.normalized_observations)
        ? output.normalized_observations.filter((observation: Record<string, unknown>) => isRecurringHistoricalObservation(observation))
        : [];
      output = { ...output, normalized_observations: normalizedObservations };
      await persistMetrics(sql, v2Ctx, primarySourceId, output);

      // 5. Fetch all observations from the DB and construct twenty-quarter HistoricalRecord
      const obsRows = await sql`
        SELECT mo.value_numeric, mo.period_start, mo.period_end, mo.as_of_date, mo.unit, mo.currency,
               mo.confidence, mo.source_document_id, mo.evidence_claim_id, mo.metadata_json,
               md.metric_key, md.metric_category
        FROM metric_observations mo
        JOIN metric_definitions md ON md.id = mo.metric_definition_id
        WHERE mo.research_run_id = ${ctx.runId}
      `;

      const observations = obsRows.filter((row) => isRecurringHistoricalObservation(row)).map(row => {
        const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json as Record<string, unknown> : {};
        const agentOutput = metadata.agent_output && typeof metadata.agent_output === "object" ? metadata.agent_output as Record<string, unknown> : {};
        const metricKey = String(row.metric_key);
        const reportingBasis = String(agentOutput.reporting_basis || metadata.reporting_basis ||
          (/(?:adjusted|non[_ -]?gaap)/i.test(metricKey) ? "as_reported" : "as_reported"));
        const comparabilityStatus = String(agentOutput.comparability_status || metadata.comparability_status || "unknown");
        const start = row.period_start ? new Date(row.period_start) : null;
        const end = new Date(row.period_end);
        const diffMonth = start ? (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) : 3;
        const periodicity = diffMonth > 6 ? "annual" : "quarterly";
        const fiscal_quarter = periodicity === "annual" ? null : Math.floor(end.getMonth() / 3) + 1;

        return {
          metric_key: metricKey,
          fiscal_year: end.getFullYear(),
          fiscal_quarter,
          periodicity: periodicity as "annual" | "quarterly",
          reporting_basis: (["gaap", "non_gaap", "adjusted", "as_reported"] as const).includes(reportingBasis as any)
            ? reportingBasis as "gaap" | "non_gaap" | "adjusted" | "as_reported"
            : "as_reported",
          metric_type: (["reported", "normalized", "calculated", "reconciled"] as const).includes(String(agentOutput.metric_type) as any)
            ? String(agentOutput.metric_type) as "reported" | "normalized" | "calculated" | "reconciled"
            : "reported",
          value_numeric: row.value_numeric != null ? Number(row.value_numeric) : null,
          unit: String(row.unit || ""),
          currency: String(row.currency || "USD"),
          confidence: Number(row.confidence || 1),
          restatement_version: 0,
          source_document_id: row.source_document_id ? String(row.source_document_id) : null,
          evidence_claim_id: row.evidence_claim_id ? String(row.evidence_claim_id) : null,
          comparability_status: (["comparable", "definition_changed", "revised", "estimated", "blocked"] as const).includes(comparabilityStatus as any)
            ? comparabilityStatus as "comparable" | "definition_changed" | "revised" | "estimated" | "blocked"
            : "blocked",
          metadata_json: metadata,
        };
      });

      // Find start/end periods
      const latestQuarter = observations
        .filter((observation) => observation.periodicity === "quarterly" && observation.fiscal_quarter != null)
        .sort((a, b) => (b.fiscal_year * 10 + (b.fiscal_quarter || 0)) - (a.fiscal_year * 10 + (a.fiscal_quarter || 0)))[0];
      const endFiscalYear = latestQuarter?.fiscal_year ?? new Date().getFullYear() - 1;
      const endFiscalQuarter = latestQuarter?.fiscal_quarter ?? 4;
      const record = buildHistoricalRecord({
        asset_id: ctx.assetId,
        run_id: ctx.runId,
        observations,
        requiredMetricKeys: [...new Set(observations.map(o => o.metric_key))],
        endFiscalYear,
        endFiscalQuarter,
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
        content_json: record as any,
        schema_version: "3.0.0",
        validator_version: "1.0.0",
        prompt_version: "current",
        created_by: "system-research-os",
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
  async validate(_ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    return makeValidationResult(Number(output?.observationsCount || 0) > 0 ? [] : ["No recurring quantitative observations recorded for this run"]);
  }
};
