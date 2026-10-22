import type { Sql, ResearchRunContext } from "../run-context";
import { linkArtifactCitations } from "../memory/graph";
import { createReport, storedFingerprint, inputFingerprint, type ReportArtifact, type ReportEvidence, type ReportDocument } from "./report";

// Review/export products cannot become their own upstream inputs.
// Full filing tables live in Financials; duplicating every filing's display cells in the writing packet exhausts
// its context. Report packets read financial_analytics and financial_statement_summary instead, and see
// historical_record only as the request view in packet.ts.
// Period-end prices and market caps (market_price_history) are likewise read in Financials.
/**
 * A point-in-time run studies the asset as of a past date, so a document without a publication date may postdate
 * the cutoff and is excluded. That is a backtest_only run, or a source cutoff set more than a day before the run was
 * created. Every other run keeps undated documents (filings fetched without a date, industry reports, peer PDFs).
 */
export function isPointInTimeRun(run: { run_type?: string | null; source_cutoff_at?: string | Date | null; created_at?: string | Date | null } | undefined) {
  if (!run) return false;
  if (run.run_type === "backtest_only") return true;
  if (!run.source_cutoff_at || !run.created_at) return false;
  return new Date(run.created_at).getTime() - new Date(run.source_cutoff_at).getTime() > 24 * 60 * 60 * 1000;
}

const products = ["agent_brief", "team_requests", "source_requests", "source_review", "research_chat", "financial_statement_set", "market_price_history", "report_outline", "report_section", "report_document", "report_review", "question_register", "synthetic_report", "refresh_schedule", "prior_research", "review_summary", "findings", "quality_score", "recommendations", "review_verdict", "depth_checks"];
/**
 * The report's upstream artifacts and accepted evidence. Gates that compare input_hash use the defaults; a
 * specialist call that needs only some artifact types passes `types`, and `fingerprint: false` / `evidence: false`
 * skip the hash (a canonical copy of every artifact) and the evidence query when it does not use them.
 */
export async function loadReportInputs(sql: Sql, runId: string, cutoff: string,
  options: { types?: string[]; fingerprint?: boolean; evidence?: boolean } = {}) {
  const rows = options.types && !options.types.length ? [] : await sql`
    SELECT DISTINCT ON (artifact_type, scope_key) id, artifact_type, scope_key, artifact_version, content_json
    FROM research_artifacts WHERE research_run_id = ${runId} AND status IN ('validated', 'accepted')
      AND artifact_type != ALL(${products}::text[])
      ${options.types ? sql`AND artifact_type = ANY(${options.types}::text[])` : sql``}
    ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
  `;
  const [run] = options.evidence === false ? [] : await sql`SELECT run_type, source_cutoff_at, created_at FROM research_runs WHERE id = ${runId}`;
  const keepUndated = !isPointInTimeRun(run);
  const claims = options.evidence === false ? [] : await sql`
    SELECT DISTINCT ON (ec.id) ec.id, ec.claim_text, sd.title AS source_title, sd.url,
      sd.published_at, el.quoted_text AS quote,
      concat('Source ', sd.id::text, ', page ', COALESCE(sl.page_start::text, 'n/a'), ', chars ',
        COALESCE(sl.char_start::text, 'n/a'), '-', COALESCE(sl.char_end::text, 'n/a')) AS location
    FROM evidence_claims ec JOIN evidence_links el ON el.evidence_claim_id = ec.id
    JOIN source_locations sl ON sl.id = el.source_location_id
    JOIN source_documents sd ON sd.id = sl.source_document_id
    WHERE ec.research_run_id = ${runId} AND ec.review_status = 'accepted'
      AND el.support_type IN ('supports', 'calculation_source')
      AND (sd.published_at <= ${cutoff}::timestamptz OR (${keepUndated} AND sd.published_at IS NULL)) AND sd.url ~ '^https?://'
      AND length(trim(COALESCE(el.quoted_text, ''))) > 0
    ORDER BY ec.id, el.confidence DESC NULLS LAST, el.id
  `;
  const artifacts = rows.map(r => ({ ...r, id: String(r.id), artifact_version: Number(r.artifact_version) })) as ReportArtifact[];
  const evidence = claims.map(r => ({ ...r, id: String(r.id), published_at: r.published_at ? new Date(r.published_at).toISOString() : null })) as ReportEvidence[];
  return { artifacts, evidence, input_hash: options.fingerprint === false ? "" : inputFingerprint(artifacts, evidence) };
}

export async function saveReportArtifact(sql: Sql, ctx: Pick<ResearchRunContext, "runId" | "assetId" | "assetSlug">,
  type: string, scope: string, content: Record<string, any>, expectedVersion?:number) {
  return sql.begin(async tx => {
    await tx`SELECT id FROM research_runs WHERE id = ${ctx.runId} FOR UPDATE`;
    const [prior] = await tx`SELECT * FROM research_artifacts
      WHERE research_run_id = ${ctx.runId} AND artifact_type = ${type} AND scope_key = ${scope}
      ORDER BY artifact_version DESC, created_at DESC LIMIT 1`;
    if (expectedVersion !== undefined && Number(prior?.artifact_version ?? 0) !== expectedVersion) throw new Error('Another answer was saved. Reopen the conversation before continuing.');
    if (prior && ['validated', 'accepted'].includes(prior.status) && storedFingerprint(prior.content_json) === storedFingerprint(content)) {
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

/**
 * A human gate accepts what it approved: the latest version of each (type, scope) moves from validated to accepted.
 * `types` limits it to those artifact types (the research-plan gate accepts only the plan).
 */
export async function acceptCurrentArtifacts(sql: Sql, runId: string, types: string[] | null = null) {
  return sql`
    UPDATE research_artifacts SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
    WHERE id IN (
      SELECT DISTINCT ON (artifact_type, scope_key) id FROM research_artifacts
      WHERE research_run_id = ${runId} AND status <> 'superseded'
        AND (${types}::text[] IS NULL OR artifact_type = ANY(${types}::text[]))
      ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC
    ) AND status = 'validated'
    RETURNING id`;
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
