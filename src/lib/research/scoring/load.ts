/**
 * SELECT-only loading for research scoring. A run that predates the analytics pack gets financial_analytics,
 * the statement summary and report_facts computed in memory, marked `computed: true`, so its checks can run.
 */
import type { Sql } from "../run-context";
import { FinancialAnalytics, buildFinancialAnalytics } from "../history/analytics";
import { buildStatementSummary } from "../history/statement-summary";
import { mergeObservations } from "../reporting/data-views";
import { buildReportFacts } from "../reporting/facts";

type Row = Record<string, any>;
export interface ScoredArtifact { id: string; artifact_type: string; scope_key: string; artifact_version: number; content_json: any; computed?: boolean }
export interface RunSnapshot {
  run: { id: string; asset_slug: string; asset_name: string; status: string; pipeline_version: number; created_at: string; cutoff: string; metadata: Row };
  artifacts: ScoredArtifact[];
  /** The report_review for the current report_document, or the newest one. */
  review: Row | null;
  document: Row | null;
  hygiene: { accepted_claims: number; claims_after_cutoff: number; undated_claims: number };
}

export async function loadRunSnapshot(sql: Sql, runId: string): Promise<RunSnapshot> {
  const [run] = await sql`SELECT r.id, r.status, r.pipeline_version, r.created_at, r.source_cutoff_at, r.metadata_json, a.slug, a.canonical_name
    FROM research_runs r JOIN assets a ON a.id = r.asset_id WHERE r.id = ${runId}`;
  if (!run) throw new Error(`Research run ${runId} not found`);
  const rows = await sql`SELECT DISTINCT ON (artifact_type, scope_key) id, artifact_type, scope_key, artifact_version, content_json
    FROM research_artifacts WHERE research_run_id = ${runId} AND status <> 'superseded'
      AND artifact_type <> ALL(${["report_section", "team_requests", "agent_brief", "research_chat"]}::text[])
    ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC`;
  const artifacts: ScoredArtifact[] = rows.map((r) => ({ id: String(r.id), artifact_type: String(r.artifact_type), scope_key: String(r.scope_key),
    artifact_version: Number(r.artifact_version), content_json: r.content_json }));
  const document = latest(artifacts, "report_document");
  const reviews = artifacts.filter((a) => a.artifact_type === "report_review");
  const review = reviews.find((a) => document && a.content_json?.report_hash === document.content_hash)?.content_json
    ?? reviews.sort((a, b) => Number(b.content_json?.round ?? 0) - Number(a.content_json?.round ?? 0))[0]?.content_json ?? null;
  const cutoff = new Date(run.source_cutoff_at ?? run.created_at).toISOString();
  const [hygiene] = await sql`SELECT count(DISTINCT ec.id)::int AS accepted_claims,
      count(DISTINCT ec.id) FILTER (WHERE sd.published_at > ${cutoff}::timestamptz)::int AS claims_after_cutoff,
      count(DISTINCT ec.id) FILTER (WHERE sd.published_at IS NULL)::int AS undated_claims
    FROM evidence_claims ec JOIN evidence_links el ON el.evidence_claim_id = ec.id
    JOIN source_locations sl ON sl.id = el.source_location_id JOIN source_documents sd ON sd.id = sl.source_document_id
    WHERE ec.research_run_id = ${runId} AND ec.review_status = 'accepted'`;
  addComputedInputs(artifacts);
  return { run: { id: String(run.id), asset_slug: String(run.slug), asset_name: String(run.canonical_name), status: String(run.status),
      pipeline_version: Number(run.pipeline_version), created_at: new Date(run.created_at).toISOString(), cutoff, metadata: run.metadata_json ?? {} },
    artifacts, review, document, hygiene: { accepted_claims: Number(hygiene?.accepted_claims ?? 0),
      claims_after_cutoff: Number(hygiene?.claims_after_cutoff ?? 0), undated_claims: Number(hygiene?.undated_claims ?? 0) } };
}

export const latest = (artifacts: ScoredArtifact[], type: string) => artifacts.filter((a) => a.artifact_type === type)
  .sort((a, b) => b.artifact_version - a.artifact_version)[0]?.content_json ?? null;

/** The Phase 1 computed inputs, rebuilt in memory from the stored statements when the run never saved them. */
export function addComputedInputs(artifacts: ScoredArtifact[]) {
  const add = (type: string, content: unknown) => content && artifacts.push({ id: `computed-${type}`, artifact_type: type, scope_key: type,
    artifact_version: 0, content_json: content, computed: true });
  if (!latest(artifacts, "financial_analytics")) {
    const set = latest(artifacts, "financial_statement_set");
    const end = [...(set?.tables ?? [])].filter((t: Row) => t.statement !== "segment" && t.period_end)
      .sort((a: Row, b: Row) => String(a.period_end).localeCompare(String(b.period_end))).at(-1);
    if (set && end) {
      try {
        const pack = FinancialAnalytics.parse(buildFinancialAnalytics({ observations: mergeObservations(set.observations ?? [],
          latest(artifacts, "historical_record")?.observations ?? [], latest(artifacts, "market_price_history")?.observations ?? []),
          endFiscalYear: end.fiscal_year, endFiscalQuarter: end.fiscal_quarter }));
        add("financial_analytics", pack);
        if (!latest(artifacts, "financial_statement_summary")) add("financial_statement_summary", buildStatementSummary(set, pack.quarterly.rows.map((row) => String(row[0]))));
      } catch { /* a run without usable statements is scored without the pack */ }
    }
  }
  if (!latest(artifacts, "report_facts")) add("report_facts", buildReportFacts(artifacts));
}
