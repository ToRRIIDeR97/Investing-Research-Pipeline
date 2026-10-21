/**
 * Run lineage in the database: which earlier run a new run builds on (research_runs.prior_run_id), the
 * prior_research block saved when the run is created, and the version_change_log saved before the report.
 * Everything here is deterministic and makes no model call.
 */
import type { ResearchRunContext, Sql } from "../run-context";
import { saveReportArtifact } from "../reporting/store";
import { buildPriorResearch, type PriorResearch, type PriorResearchInputs } from "./prior-research";
import { buildVersionChangeLog, type VersionChangeLog } from "./change-log";

/** Prior-run artifacts the lineage reads; everything else stays in the prior run. */
const LINEAGE_TYPES = ["decision_record", "investment_thesis", "expected_return_matrix", "question_register", "team_requests",
  "valuation_scenario_set", "operating_scenario_set"];
const APPROVED = ["approved_for_tracking", "approved_for_position"];

export class PriorRunError extends Error {
  constructor(message: string, public code: "PRIOR_RUN_NOT_FOUND" | "PRIOR_RUN_OTHER_ASSET" | "PRIOR_RUN_UNSUPPORTED") {
    super(message);
    this.name = "PriorRunError";
  }
}

/** The asset's most recent completed, or human-approved, pipeline-v3 run. */
export async function defaultPriorRunId(sql: Sql, assetId: string, pipelineVersion = 3): Promise<string | null> {
  const [row] = await sql`SELECT rr.id FROM research_runs rr
    WHERE rr.asset_id = ${assetId} AND rr.pipeline_version = ${pipelineVersion}
      AND (rr.status = 'completed' OR EXISTS (SELECT 1 FROM review_decisions rd
        WHERE rd.research_run_id = rr.id AND rd.status = ANY(${APPROVED}::text[])))
    ORDER BY COALESCE(rr.completed_at, rr.updated_at, rr.created_at) DESC, rr.created_at DESC, rr.id DESC
    LIMIT 1`;
  return row ? String(row.id) : null;
}

/**
 * undefined: link the default prior run. null: a fresh start. A run id: that run, which must be a
 * pipeline-v3 run of the same asset.
 */
export async function resolvePriorRunId(sql: Sql, assetId: string, requested: string | null | undefined, pipelineVersion = 3) {
  if (requested === null) return null;
  if (requested === undefined) return defaultPriorRunId(sql, assetId, pipelineVersion);
  const [row] = await sql`SELECT id, asset_id, pipeline_version FROM research_runs WHERE id = ${requested}`;
  if (!row) throw new PriorRunError("Prior run not found", "PRIOR_RUN_NOT_FOUND");
  if (String(row.asset_id) !== assetId) throw new PriorRunError("The prior run belongs to a different asset", "PRIOR_RUN_OTHER_ASSET");
  if (Number(row.pipeline_version) !== pipelineVersion) throw new PriorRunError(`The prior run must be a pipeline-v${pipelineVersion} run`, "PRIOR_RUN_UNSUPPORTED");
  return String(row.id);
}

async function latestArtifacts(sql: Sql, runId: string, types = LINEAGE_TYPES) {
  return sql`SELECT DISTINCT ON (artifact_type, scope_key) artifact_type, scope_key, artifact_version, status, content_json
    FROM research_artifacts WHERE research_run_id = ${runId} AND status IN ('validated', 'accepted')
      AND artifact_type = ANY(${types}::text[])
    ORDER BY artifact_type, scope_key, artifact_version DESC, created_at DESC`;
}

async function runDocuments(sql: Sql, runId: string) {
  return sql`SELECT DISTINCT sd.id, sd.title, sd.url, sd.published_at FROM research_run_sources rrs
    JOIN source_documents sd ON sd.id = rrs.source_document_id WHERE rrs.research_run_id = ${runId}`;
}

export async function loadPriorResearchInputs(sql: Sql, priorRunId: string): Promise<PriorResearchInputs> {
  const [run] = await sql`SELECT id, run_type, status, source_cutoff_at, completed_at FROM research_runs WHERE id = ${priorRunId}`;
  if (!run) throw new PriorRunError("Prior run not found", "PRIOR_RUN_NOT_FOUND");
  const [review] = await sql`SELECT status, open_questions, what_would_change_mind FROM review_decisions
    WHERE research_run_id = ${priorRunId} AND status = ANY(${APPROVED}::text[]) ORDER BY reviewed_at DESC LIMIT 1`;
  return {
    run: { id: String(run.id), run_type: String(run.run_type), status: String(run.status), source_cutoff_at: run.source_cutoff_at, completed_at: run.completed_at },
    artifacts: [...await latestArtifacts(sql, priorRunId)],
    documents: (await runDocuments(sql, priorRunId)).map(d => ({ id: String(d.id), title: d.title, url: d.url, published_at: d.published_at })),
    review: review ? { status: String(review.status), open_questions: review.open_questions, what_would_change_mind: review.what_would_change_mind } : null,
  };
}

/** Save the run's prior_research block (called in the run-creation transaction). */
export async function savePriorResearch(sql: Sql, run: { id: string; asset_id: string; prior_run_id: string }) {
  const [asset] = await sql`SELECT slug FROM assets WHERE id = ${run.asset_id}`;
  const block = buildPriorResearch(await loadPriorResearchInputs(sql, run.prior_run_id));
  await sql`INSERT INTO research_artifacts
    (research_run_id, asset_id, artifact_type, scope_key, artifact_version, status, content_json,
     schema_version, validator_version, prompt_version, created_by)
    VALUES (${run.id}, ${run.asset_id}, 'prior_research', ${`${asset?.slug ?? run.asset_id}-prior-research`}, 1, 'validated',
      ${JSON.stringify({ artifact_type: "prior_research", ...block })}::text::jsonb, '1.0.0', '1.0.0', 'lineage-1', 'system-research-os')`;
  return block;
}

/** The run's stored prior_research block, or null for a fresh start. */
export async function loadPriorResearch(sql: Sql, runId: string): Promise<PriorResearch | null> {
  const [row] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'prior_research' AND status IN ('validated', 'accepted') ORDER BY artifact_version DESC, created_at DESC LIMIT 1`;
  if (!row) return null;
  const block = { ...(row.content_json as Record<string, unknown>) };
  delete block.artifact_type;
  return block as unknown as PriorResearch;
}

/** Diff this run against its prior run and save version_change_log; null when the run has no prior. */
export async function saveVersionChangeLog(sql: Sql, ctx: Pick<ResearchRunContext, "runId" | "assetId" | "assetSlug">): Promise<VersionChangeLog | null> {
  const [run] = await sql`SELECT r.prior_run_id, r.source_cutoff_at, p.source_cutoff_at AS prior_cutoff FROM research_runs r
    LEFT JOIN research_runs p ON p.id = r.prior_run_id WHERE r.id = ${ctx.runId}`;
  if (!run?.prior_run_id) return null;
  const priorId = String(run.prior_run_id);
  const iso = (value: unknown) => value ? new Date(value as string).toISOString() : null;
  const ids = async (runId: string) => (await runDocuments(sql, runId)).map(d => String(d.id));
  const log = buildVersionChangeLog(priorId,
    { artifacts: [...await latestArtifacts(sql, priorId)], source_cutoff: iso(run.prior_cutoff), document_ids: await ids(priorId) },
    { artifacts: [...await latestArtifacts(sql, ctx.runId)], source_cutoff: iso(run.source_cutoff_at), document_ids: await ids(ctx.runId) });
  await saveReportArtifact(sql, ctx, "version_change_log", `${ctx.assetSlug}-version-change-log`, log);
  return log;
}
