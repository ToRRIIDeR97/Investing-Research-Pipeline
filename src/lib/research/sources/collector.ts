import type { ResearchRunContext, Sql } from "../run-context";
import { extractEvidenceForSources } from "../handlers/evidence-extraction";
import { storeDiscoveredSources } from "./corpus";
import { discoverRoleSources } from "./role-discovery";
import { recordSourceCoverage, reconcileRoleGaps, sourcePlanFor, v2RunContext, withLinkedRunSources } from "./role-coverage";
import type { SourceRole } from "./roles";
import { getQueuedSourceRequests, saveStageSourceRequests, type FetchedDocument, type SourceSearch } from "./source-requests";

export type SearchResult = SourceSearch & { status: "fetched" | "unavailable"; documents: FetchedDocument[] };

/** Run named searches and store what was fetched, attributing each document to the query that found it. */
export async function runSearches(sql: Sql, ctx: ResearchRunContext, searches: SourceSearch[], requestedBy: string): Promise<SearchResult[]> {
  const roleQueries: Partial<Record<SourceRole, string[]>> = {};
  for (const search of searches) (roleQueries[search.source_role] ||= []).push(search.query);
  const discovered = await discoverRoleSources({ assetName: ctx.assetName, symbol: ctx.symbol,
    cutoffAt: ctx.cutoffAt.toISOString(), roleQueries, requestedOnly: true }, searches.map(search => search.source_role));
  const stored = await storeDiscoveredSources(sql, v2RunContext(ctx), discovered);
  // A document already stored by another run keeps its first metadata, so attribute by fetch order.
  const results = searches.map(search => {
    const documents = stored.filter((_, index) => discovered[index].metadata.discovery_query === search.query
      && discovered[index].metadata.source_role === search.source_role)
      .map(source => ({ source_id: source.sourceId, title: source.title, url: source.url || null }));
    return { ...search, status: documents.length ? "fetched" as const : "unavailable" as const, documents };
  });
  for (const result of results) await sql`INSERT INTO source_retrieval_attempts
    (research_run_id, source_role, attempt_status, failure_reason, attempt_metadata_json)
    VALUES (${ctx.runId}, ${result.source_role}, ${result.status === "fetched" ? "attempted" : "unavailable"},
      ${result.status === "fetched" ? null : "no_substantive_source_fetched"},
      ${sql.json({ query: result.query, reason: result.reason, fetched_documents: result.documents.length, requested_by: requestedBy })})`;
  return results;
}

/** Reasons the collector gave for required roles it could not cover. */
export async function collectorGapNotes(sql: Sql, runId: string): Promise<Partial<Record<SourceRole, string>>> {
  const [row] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'source_review' AND status = 'validated' ORDER BY artifact_version DESC LIMIT 1`;
  const rounds = (row?.content_json?.rounds || []) as { accepted_gaps?: { source_role: SourceRole; reason: string }[] }[];
  return Object.fromEntries((rounds[rounds.length - 1]?.accepted_gaps || []).map(gap => [gap.source_role, gap.reason]));
}

/**
 * Serve every queued specialist request: fetch the named documents, read only those documents into
 * evidence, and refresh role coverage. The requesting stages are still running and rerun afterwards.
 */
export async function processSourceRequests(sql: Sql, ctx: ResearchRunContext): Promise<boolean> {
  const ledgers = await getQueuedSourceRequests(sql, ctx.runId);
  if (!ledgers.length) return false;
  for (const ledger of ledgers) {
    const queued = ledger.rounds.find(round => round.state === "queued")!;
    const results = await runSearches(sql, ctx, queued.requests, `${ledger.role}:${ledger.stage_key}`);
    await extractEvidenceForSources(sql, ctx, [...new Set(results.flatMap(result => result.documents.map(document => document.source_id)))]);
    await saveStageSourceRequests(sql, ctx, { ...ledger, rounds: ledger.rounds.map(round => round !== queued ? round : {
      ...round, state: "fetched",
      requests: round.requests.map((request, index) => ({ ...request, status: results[index].status, documents: results[index].documents })),
    }) });
  }
  const plan = sourcePlanFor(ctx);
  const covered = await recordSourceCoverage(sql, ctx.runId, await withLinkedRunSources(sql, ctx.runId, []), plan);
  await reconcileRoleGaps(sql, v2RunContext(ctx), plan, covered, await collectorGapNotes(sql, ctx.runId));
  return true;
}
