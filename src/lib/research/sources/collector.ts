import type { ResearchRunContext, Sql } from "../run-context";
import { extractEvidenceForSources } from "../handlers/evidence-extraction";
import { getEmbeddingProvider, retrievePassages } from "../memory";
import { storeDiscoveredSources } from "./corpus";
import { discoverRoleSources } from "./role-discovery";
import { recordSourceCoverage, reconcileRoleGaps, sourcePlanFor, v2RunContext, withLinkedRunSources } from "./role-coverage";
import type { SourceRole } from "./roles";
import { constrainSearch, getQueuedSourceRequests, queryTermCoverage, saveStageSourceRequests, type FetchedDocument, type SourceSearch,
  type StageSourceRequest } from "./source-requests";

export type SearchResult = SourceSearch & { status: "fetched" | "unavailable"; documents: FetchedDocument[] };

/**
 * Run named searches and store what was fetched, attributing each document to the query that found it. Every query
 * is model-chosen, so each passes constrainSearch first; a rejected one is recorded unavailable and never sent.
 */
export async function runSearches(sql: Sql, ctx: ResearchRunContext, requested: SourceSearch[], requestedBy: string,
  metadata: Record<string, unknown> = {}): Promise<SearchResult[]> {
  const constrained = requested.map(search => constrainSearch(search, { name: ctx.assetName, symbol: ctx.symbol }));
  const searches = constrained.filter((search): search is SourceSearch => Boolean(search));
  const roleQueries: Partial<Record<SourceRole, string[]>> = {};
  for (const search of searches) (roleQueries[search.source_role] ||= []).push(search.query);
  const discovered = searches.length ? await discoverRoleSources({ assetName: ctx.assetName, symbol: ctx.symbol,
    cutoffAt: ctx.cutoffAt.toISOString(), roleQueries, requestedOnly: true }, searches.map(search => search.source_role)) : [];
  const stored = await storeDiscoveredSources(sql, v2RunContext(ctx), discovered);
  // A document already stored by another run keeps its first metadata, so attribute by fetch order.
  const results = constrained.map((search, index) => {
    if (!search) return { ...requested[index], status: "unavailable" as const, documents: [], rejected: true };
    const documents = stored.filter((_, index) => discovered[index].metadata.discovery_query === search.query
      && discovered[index].metadata.source_role === search.source_role)
      .map(source => ({ source_id: source.sourceId, title: source.title, url: source.url || null }));
    return { ...search, status: documents.length ? "fetched" as const : "unavailable" as const, documents, rejected: false };
  });
  // Every model-chosen query is logged with the text the model asked for, so a steered search can be reviewed.
  for (const [index, { rejected, ...result }] of results.entries()) await sql`INSERT INTO source_retrieval_attempts
    (research_run_id, source_role, attempt_status, failure_reason, attempt_metadata_json)
    VALUES (${ctx.runId}, ${result.source_role}, ${result.status === "fetched" ? "attempted" : "unavailable"},
      ${result.status === "fetched" ? null : rejected ? "query_rejected" : "no_substantive_source_fetched"},
      ${sql.json({ query: result.query, requested_query: requested[index].query, reason: result.reason,
        fetched_documents: result.documents.length, requested_by: requestedBy, ...metadata } as any)})`;
  return results.map(({ rejected: _, ...result }) => result);
}

/** Reasons the collector gave for required roles it could not cover. */
export async function collectorGapNotes(sql: Sql, runId: string): Promise<Partial<Record<SourceRole, string>>> {
  const [row] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'source_review' AND status IN ('validated', 'accepted') ORDER BY artifact_version DESC LIMIT 1`;
  const rounds = (row?.content_json?.rounds || []) as { accepted_gaps?: { source_role: SourceRole; reason: string }[] }[];
  return Object.fromEntries((rounds[rounds.length - 1]?.accepted_gaps || []).map(gap => [gap.source_role, gap.reason]));
}

/** Minimum share of a query's significant terms a passage must contain for the corpus to answer the search. */
const IN_CORPUS_COVERAGE = 0.6;

/**
 * Documents the run already holds for a search. Keyword retrieval matches any query term, so a passage
 * counts only when its document has the requested role and it contains most of the query's terms.
 */
async function corpusDocuments(sql: Sql, runId: string, search: StageSourceRequest): Promise<FetchedDocument[]> {
  const { passages } = await retrievePassages(sql, { runId, need: { key: search.id, query: search.query, sourceRoles: [search.source_role] },
    embeddings: getEmbeddingProvider() });
  const ids = [...new Set(passages.filter(p => p.source_role === search.source_role
    && queryTermCoverage(search.query, p.text) >= IN_CORPUS_COVERAGE).map(p => p.source_id))];
  if (!ids.length) return [];
  const rows = await sql`SELECT id, title, url FROM source_documents WHERE id = ANY(${ids}::uuid[])`;
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return ids.map(id => ({ source_id: id, title: String(byId.get(id)?.title || ""), url: byId.get(id)?.url ? String(byId.get(id)!.url) : null }));
}

/**
 * Serve every queued specialist request: a search the run corpus already answers is recorded in_corpus;
 * the others fetch the named documents, read only those documents into evidence, and refresh role
 * coverage. The requesting stages are still running and rerun afterwards.
 */
export async function processSourceRequests(sql: Sql, ctx: ResearchRunContext): Promise<boolean> {
  const ledgers = await getQueuedSourceRequests(sql, ctx.runId);
  if (!ledgers.length) return false;
  for (const ledger of ledgers) {
    const queued = ledger.rounds.find(round => round.state === "queued")!;
    const held: FetchedDocument[][] = [];
    for (const request of queued.requests) held.push(await corpusDocuments(sql, ctx.runId, request));
    const searches = queued.requests.filter((_, index) => !held[index].length);
    const results = searches.length ? await runSearches(sql, ctx, searches, `${ledger.role}:${ledger.stage_key}`) : [];
    await extractEvidenceForSources(sql, ctx, [...new Set(results.flatMap(result => result.documents.map(document => document.source_id)))]);
    let next = 0;
    await saveStageSourceRequests(sql, ctx, { ...ledger, rounds: ledger.rounds.map(round => round !== queued ? round : {
      ...round, state: "fetched",
      requests: round.requests.map((request, index) => {
        if (held[index].length) return { ...request, status: "in_corpus" as const, documents: held[index] };
        const result = results[next++];
        return { ...request, status: result.status, documents: result.documents };
      }),
    }) });
  }
  const plan = sourcePlanFor(ctx);
  const covered = await recordSourceCoverage(sql, ctx.runId, await withLinkedRunSources(sql, ctx.runId, []), plan);
  await reconcileRoleGaps(sql, v2RunContext(ctx), plan, covered, await collectorGapNotes(sql, ctx.runId));
  return true;
}
