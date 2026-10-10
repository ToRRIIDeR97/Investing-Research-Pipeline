import type { Sql, ResearchRunContext } from "../run-context";
import { linkArtifactCitations } from "../memory/graph";
import { createReport, fingerprint, inputFingerprint, type ReportArtifact, type ReportEvidence, type ReportDocument } from "./report";

// Review/export products cannot become their own upstream inputs.
// Full filing tables live in Financials. The report uses historical_record observations;
// duplicating every filing's display cells in the writing packet exhausts its context.
// Period-end prices and market caps (market_price_history) are likewise read in Financials.
const products = ["agent_brief", "team_requests", "source_requests", "source_review", "research_chat", "financial_statement_set", "market_price_history", "report_outline", "report_section", "report_document", "report_review", "question_register", "synthetic_report", "refresh_schedule", "review_summary", "findings", "quality_score", "recommendations", "review_verdict"];
export async function loadReportInputs(sql: Sql, runId: string, cutoff: string) {
  const rows = await sql`
    SELECT DISTINCT ON (artifact_type, scope_key) id, artifact_type, scope_key, artifact_version, content_json
    FROM research_artifacts WHERE research_run_id = ${runId} AND status IN ('validated', 'accepted')
      AND artifact_type != ALL(${products}::text[])
    ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
  `;
  const claims = await sql`
    SELECT DISTINCT ON (ec.id) ec.id, ec.claim_text, sd.title AS source_title, sd.url,
      sd.published_at, el.quoted_text AS quote,
      concat('Source ', sd.id::text, ', page ', COALESCE(sl.page_start::text, 'n/a'), ', chars ',
        COALESCE(sl.char_start::text, 'n/a'), '-', COALESCE(sl.char_end::text, 'n/a')) AS location
    FROM evidence_claims ec JOIN evidence_links el ON el.evidence_claim_id = ec.id
    JOIN source_locations sl ON sl.id = el.source_location_id
    JOIN source_documents sd ON sd.id = sl.source_document_id
    WHERE ec.research_run_id = ${runId} AND ec.review_status = 'accepted'
      AND el.support_type IN ('supports', 'calculation_source')
      AND sd.published_at <= ${cutoff}::timestamptz AND sd.url ~ '^https?://'
      AND length(trim(COALESCE(el.quoted_text, ''))) > 0
    ORDER BY ec.id, el.confidence DESC NULLS LAST, el.id
  `;
  const artifacts = rows.map(r => ({ ...r, id: String(r.id), artifact_version: Number(r.artifact_version) })) as ReportArtifact[];
  const evidence = claims.map(r => ({ ...r, id: String(r.id), published_at: new Date(r.published_at).toISOString() })) as ReportEvidence[];
  return { artifacts, evidence, input_hash: inputFingerprint(artifacts, evidence) };
}

export async function saveReportArtifact(sql: Sql, ctx: Pick<ResearchRunContext, "runId" | "assetId" | "assetSlug">,
  type: string, scope: string, content: Record<string, any>, expectedVersion?:number) {
  return sql.begin(async tx => {
    await tx`SELECT id FROM research_runs WHERE id = ${ctx.runId} FOR UPDATE`;
    const [prior] = await tx`SELECT * FROM research_artifacts
      WHERE research_run_id = ${ctx.runId} AND artifact_type = ${type} AND scope_key = ${scope}
      ORDER BY artifact_version DESC, created_at DESC LIMIT 1`;
    if (expectedVersion !== undefined && Number(prior?.artifact_version ?? 0) !== expectedVersion) throw new Error('Another answer was saved. Reopen the conversation before continuing.');
    if (prior && ['validated', 'accepted'].includes(prior.status) && fingerprint(prior.content_json) === fingerprint(content)) {
      await linkArtifactCitations(tx, { artifactId: prior.id, runId: ctx.runId, content: prior.content_json });
      return prior;
    }
    const [row] = await tx`INSERT INTO research_artifacts
      (research_run_id, asset_id, artifact_type, scope_key, artifact_version, status, content_json,
       schema_version, validator_version, prompt_version, created_by, supersedes_artifact_id)
      VALUES (${ctx.runId}, ${ctx.assetId}, ${type}, ${scope}, ${Number(prior?.artifact_version || 0) + 1},
       'validated', ${JSON.stringify(content)}::text::jsonb, '1.0.0', '1.0.0', 'adaptive-report-1', 'system-research-os', ${prior?.id || null}) RETURNING *`;
    if (prior) await tx`UPDATE research_artifacts SET status = 'superseded' WHERE id = ${prior.id}`;
    await linkArtifactCitations(tx, { artifactId: row.id, runId: ctx.runId, content });
    return row;
  });
}

export async function getReportState(sql: Sql, runId: string) {
  const [run] = await sql`SELECT metadata_json, source_cutoff_at FROM research_runs WHERE id = ${runId}`;
  const [plan] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'research_plan' ORDER BY artifact_version DESC, created_at DESC LIMIT 1`;
  const [report] = await sql`SELECT id, content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'report_document' AND status IN ('validated', 'accepted')
    ORDER BY artifact_version DESC, created_at DESC LIMIT 1`;
  if (report) {
    const reconstructed = createReport(report.content_json as ReportDocument);
    if (reconstructed.content_hash !== report.content_json.content_hash || reconstructed.markdown !== report.content_json.markdown || reconstructed.input_hash !== report.content_json.input_hash) {
      throw new Error("Stored report integrity check failed; regenerate the report before approval or export");
    }
  }
  const [review] = report ? await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'report_review' AND content_json->>'report_hash' = ${report.content_json.content_hash}
    ORDER BY created_at DESC LIMIT 1` : [];
  return { required: Boolean(plan?.content_json?.report_standard),
    document: (report?.content_json || null) as ReportDocument | null,
    approval: run?.metadata_json?.report_approval || null,
    review: review?.content_json || null,
    cutoff: new Date(run?.source_cutoff_at || 0).toISOString() };
}
