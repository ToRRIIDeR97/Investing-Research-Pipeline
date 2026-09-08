import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from '../run-context';
import { artifactHandoff, reportInputs, reportNumericValues, REPORT_COMPOSITION_CONTRACT, validateReportComposition } from '../report-composition';
import { taskInputFingerprint } from '../artifact-packets';
import { createArtifactRepository } from '../artifacts/repository';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema } from '@/db';

/** A checkpoint inside decision synthesis, before either review gate. */
export async function composeResearchReport(sql: Sql, ctx: ResearchRunContext) {
  const rows = await sql`SELECT artifact_type, content_json FROM research_artifacts
    WHERE research_run_id = ${ctx.runId} AND status IN ('validated', 'accepted') ORDER BY artifact_type`;
  const artifacts = reportInputs(rows.map((row) => ({ artifact_type: String(row.artifact_type), content_json: row.content_json })));
  const inputFingerprint = taskInputFingerprint(artifacts);
  const packet = {
    output_contract: 'report_composition', asset: { name: ctx.assetName, symbol: ctx.symbol },
    section_handoffs: artifacts.map(artifactHandoff), numeric_values: reportNumericValues(artifacts),
    report_sections: ['Executive conclusion', 'Company genesis', 'Asset definition', 'Evidence map', 'Historical record',
      'Historical diagnosis', 'Segments', 'Customer decisions', 'Business processes', 'Competitive response', 'Moat',
      'Operating model', 'Reconciliation', 'Reinvestment', 'Scenarios', 'Valuation', 'Price targets', 'Reverse valuation',
      'Expected returns', 'Risks and catalysts', 'Thesis breakers', 'Monitoring', 'Backtest and confidence', 'Human decision', 'Limitations']
      .map((title, index) => ({ section_number: index + 1, title })),
  };
  if (Buffer.byteLength(JSON.stringify(packet)) > 96_000) throw new Error('Report composition packet exceeds its 96000-byte bound');
  const composition = await callResearchAgent({
    sql, ctx, stageKey: 'decision_synthesis', taskKey: `report-composer:v1:${inputFingerprint}`,
    taskType: 'report_composition', agentName: 'export-writer', packet, outputFormat: REPORT_COMPOSITION_CONTRACT,
    policy: { maxAttempts: 2, maxRepairAttempts: 0 },
    promptFactory: (p) => exactJsonPrompt({ agentName: 'export-writer', requiredKeys: REPORT_COMPOSITION_CONTRACT.requiredKeys, packet: p,
      extraRules: ['Stitch the accepted research into an executive summary, section transitions, and closing assessment. Do not repeat entire sections.',
        'No new research, assumptions, or facts. Preserve disagreements and limitations. A truncated handoff is not the full underlying analysis.',
        'Include each supplied section number exactly once. Keep executive conclusion first and human decision and limitations last.',
        'Never type numbers in prose. Refer to a saved numeric value using {{value:exact.key}}. Values render exactly from accepted records.',
        'Use artifact_refs to identify the accepted artifacts supporting your synthesis. Human approval remains pending.'] }),
    validateStructured: (value) => validateReportComposition(value, artifacts),
  });
  const content = { ...composition, input_fingerprint: inputFingerprint };
  await createArtifactRepository(drizzle(sql, { schema })).upsertArtifact({
    research_run_id: ctx.runId, asset_id: ctx.assetId, artifact_type: 'report_composition',
    scope_key: `${ctx.assetSlug}-report-composition`, status: 'validated', content_json: content,
    schema_version: '1.0.0', validator_version: '1.0.0', prompt_version: 'report-composer-v1', created_by: 'export-writer',
    idempotency_key: `${ctx.runId}-report-composition`,
  });
  return content;
}
