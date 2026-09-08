import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult } from "../run-context";
import { generateReport, mapArtifactsToReportData } from "@/lib/export/report-generator";
import postgres from "postgres";
import { CURRENT_PIPELINE_VERSION } from "../version";
import { reportSnapshotFingerprint, ReportReviewRequiredError } from '../report-composition';

export const exportHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "export",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      // Load accepted/validated artifacts for the run
      const artifacts = await sql`
        SELECT artifact_type, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type
      `;
      const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}`;
      const snapshot = reportSnapshotFingerprint(artifacts.map((row) => ({ artifact_type: String(row.artifact_type), content_json: row.content_json })));
      if (artifacts.some((row) => row.artifact_type === 'report_composition') && run?.metadata_json?.approved_artifact_hash !== snapshot) {
        await sql.begin(async (tx) => {
          await tx`UPDATE research_stages SET status = 'waiting_for_human', completed_at = NULL WHERE research_run_id = ${ctx.runId} AND stage_key = 'human_review'`;
          await tx`UPDATE research_stages SET status = 'pending', completed_at = NULL WHERE research_run_id = ${ctx.runId} AND stage_key = 'export'`;
          await tx`UPDATE research_runs SET status = 'waiting_for_human' WHERE id = ${ctx.runId}`;
        });
        throw new ReportReviewRequiredError('Research changed after approval; a new human review is required before export');
      }

      // Load asset info
      const [asset] = await sql`
        SELECT a.canonical_name, a.slug, a.asset_kind, rp.required_valuation_lenses_json
        FROM assets a
        LEFT JOIN research_profiles rp ON rp.id = ${ctx.profileId}
        WHERE a.id = ${ctx.assetId}
        LIMIT 1
      `;

      const reportData = mapArtifactsToReportData({
        runId: ctx.runId,
        asset: {
          canonical_name: asset?.canonical_name || ctx.assetName || "Unknown",
          slug: asset?.slug || ctx.assetSlug || "unknown",
          asset_kind: asset?.asset_kind || "equity",
        },
        artifacts: artifacts.map((artifact) => ({
          artifact_type: String(artifact.artifact_type),
          content_json: artifact.content_json as Record<string, unknown>,
        })),
        requiredValuationMethods: Array.isArray(asset?.required_valuation_lenses_json)
          ? asset.required_valuation_lenses_json.map(String)
          : [],
        isTestRun: process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock" || process.env.RESEARCH_TEST_MODE === "1",
      });

      const result = await generateReport({
        runId: ctx.runId,
        data: reportData,
        generatedBy: "system-research-os",
      });

      // Keep the durable export index in sync with the report artifact. The
      // index is the compatibility/read-model surface used by workflow gates
      // and downstream package builders.
      const exportMetadata = { exportId: result.exportId, pipelineVersion: CURRENT_PIPELINE_VERSION };
      const updatedExport = await sql`
        UPDATE exports
        SET template_version = '3.0.0', storage_path = ${result.storagePath},
            content_hash = ${result.contentHash}, generated_by = 'system-research-os',
            generated_at = NOW(), metadata_json = ${sql.json(exportMetadata)}
        WHERE id = (
          SELECT id FROM exports
          WHERE research_run_id = ${ctx.runId} AND export_type = 'markdown_memo'
          ORDER BY generated_at DESC LIMIT 1
        )
      `;
      if (updatedExport.count === 0) {
        await sql`
          INSERT INTO exports (
            asset_id, research_run_id, export_type, template_version,
            storage_path, content_hash, generated_by, generated_at, metadata_json
          ) VALUES (
            ${ctx.assetId}, ${ctx.runId}, 'markdown_memo', '3.0.0',
            ${result.storagePath}, ${result.contentHash}, 'system-research-os', NOW(),
            ${sql.json(exportMetadata)}
          )
        `;
      }

      // Idempotent: only insert if no synthetic report exists for this run
      const existing = await sql`
        SELECT id FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type = 'synthetic_report'
        LIMIT 1
      `;

      const syntheticContent = {
        exportId: result.exportId,
        storagePath: result.storagePath,
        contentHash: result.contentHash,
        generatedAt: new Date().toISOString(),
        sections: 25,
      };
      if (existing[0]) {
        await sql`
          UPDATE research_artifacts
          SET content_json = ${sql.json(syntheticContent)}, status = 'validated', updated_at = NOW()
          WHERE id = ${existing[0].id}
        `;
      } else {
        await sql`
          INSERT INTO research_artifacts (
            research_run_id, asset_id, artifact_type, scope_key,
            status, content_json, schema_version, validator_version,
            prompt_version, created_by
          ) VALUES (
            ${ctx.runId}, ${ctx.assetId}, 'synthetic_report',
            ${`${ctx.assetSlug}-synthetic-report`},
            'validated',
            ${sql.json(syntheticContent)},
            '3.0.0', '1.0.0', 'current', 'system-research-os'
          )
        `;
      }

      return {
        exported: true,
        exportId: result.exportId,
        storagePath: result.storagePath,
        contentHash: result.contentHash,
      };
    } finally {
      await sql.end();
    }
  },
  async validate(_ctx: ResearchRunContext, output: unknown): Promise<ValidationResult> {
    const out = output as Record<string, unknown> | undefined;
    const errors: string[] = [];
    if (!out?.exported) errors.push("Export did not complete");
    if (!out?.exportId) errors.push("No export ID generated");
    return makeValidationResult(errors);
  }
};
