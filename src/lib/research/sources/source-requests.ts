import { z } from "zod/v4";
import type { ResearchRunContext, Sql } from "../run-context";
import { saveReportArtifact } from "../reporting/store";
import { MAX_STAGE_SOURCE_REQUEST_ROUNDS, type TeamRole } from "../team-plan";
import { SOURCE_ROLES } from "./roles";

/** A document search one agent asks the collector to run. Queries name the document, not the topic. */
export const SourceSearch = z.object({
  source_role: z.enum(SOURCE_ROLES),
  query: z.string().trim().min(5).max(300),
  reason: z.string().trim().min(5).max(600),
});
export type SourceSearch = z.infer<typeof SourceSearch>;
export const MAX_SEARCHES_PER_REQUEST = 3;

export type FetchedDocument = { source_id: string; title: string; url: string | null };
/** in_corpus: the run already holds a document of the requested role that covers the query, so nothing was fetched. */
export type StageSourceRequest = SourceSearch & { id: string; status?: "fetched" | "unavailable" | "in_corpus"; documents?: FetchedDocument[] };

const STOP_WORDS = new Set(["the", "and", "for", "from", "with", "into", "onto", "its", "their", "our", "this", "that", "these", "those",
  "are", "was", "were", "has", "have", "had", "not", "but", "all", "any", "per", "via", "about", "over", "under", "than", "then", "also"]);
/** Lower-cased runs of letters and digits, keeping inner hyphens ("10-K" is 10-k). */
const terms = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];

/**
 * Share of the query's significant terms (distinct, at least three characters, not stop words) that occur
 * in the text, by exact token match. 0 when the query has no significant term.
 */
export function queryTermCoverage(query: string, text: string): number {
  const significant = [...new Set(terms(query))].filter(term => term.length >= 3 && !STOP_WORDS.has(term));
  if (!significant.length) return 0;
  const words = new Set(terms(text));
  return significant.filter(term => words.has(term)).length / significant.length;
}
export interface SourceRequestRound { round: number; task_key: string; state: "queued" | "fetched"; requests: StageSourceRequest[] }
/** One ledger per stage, so parallel specialists never rewrite each other's requests. */
export interface StageSourceRequests { stage_key: string; role: TeamRole; rounds: SourceRequestRound[] }

export class SourceRequestsPending extends Error {
  constructor(readonly stageKey: string) { super(`Stage ${stageKey} is waiting for requested sources`); }
}

export async function getStageSourceRequests(sql: Sql, runId: string, stageKey: string): Promise<StageSourceRequests | null> {
  const [row] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'source_requests' AND scope_key = ${stageKey} AND status IN ('validated', 'accepted')
    ORDER BY artifact_version DESC LIMIT 1`;
  return row?.content_json || null;
}

export async function getQueuedSourceRequests(sql: Sql, runId: string): Promise<StageSourceRequests[]> {
  const rows = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'source_requests' AND status IN ('validated', 'accepted')
    AND content_json->'rounds' @> '[{"state": "queued"}]'::jsonb ORDER BY scope_key`;
  return rows.map(row => row.content_json as StageSourceRequests);
}

export function saveStageSourceRequests(sql: Sql, ctx: Pick<ResearchRunContext, "runId" | "assetId" | "assetSlug">, ledger: StageSourceRequests) {
  return saveReportArtifact(sql, ctx, "source_requests", ledger.stage_key, ledger);
}

/** What a specialist sees about its own requests: whether it may ask again and what earlier asks found. */
export function sourceRequestContext(ledger: StageSourceRequests | null) {
  const rounds = ledger?.rounds || [];
  const allowed = rounds.length < MAX_STAGE_SOURCE_REQUEST_ROUNDS;
  return {
    allowed,
    rounds_used: rounds.length,
    max_rounds: MAX_STAGE_SOURCE_REQUEST_ROUNDS,
    previous: rounds.flatMap(round => round.requests.map(request => ({
      source_role: request.source_role, query: request.query, status: request.status || "pending",
      documents: (request.documents || []).map(document => ({ title: document.title, url: document.url })),
    }))),
  };
}

export function sourceRequestRule(allowed: boolean): string {
  return allowed
    ? `If a material conclusion depends on a document missing from the corpus, you may add an optional top-level key source_requests alongside the required keys: an array of at most ${MAX_SEARCHES_PER_REQUEST} objects {source_role, query, reason}. Each query must name a specific document or entity to search for (for example a named competitor's latest annual report), never a generic phrase. The collector fetches the documents and this task reruns with them; team_context.source_requests.previous lists what earlier requests found. Omit source_requests when the corpus is adequate, and do not repeat a previous query.`
    : "Do not return source_requests: this stage has used its collector rounds. Work with the supplied corpus and record remaining gaps in the output.";
}

/** Valid requests from a specialist output, excluding queries this stage already asked. */
export function parseSourceRequests(value: unknown, ledger: StageSourceRequests | null): SourceSearch[] {
  if (!Array.isArray(value)) return [];
  const asked = new Set((ledger?.rounds || []).flatMap(round => round.requests.map(request => request.query.toLowerCase())));
  const searches: SourceSearch[] = [];
  for (const item of value) {
    const parsed = SourceSearch.safeParse(item);
    if (!parsed.success) continue;
    const key = parsed.data.query.toLowerCase();
    if (asked.has(key)) continue;
    asked.add(key);
    searches.push(parsed.data);
    if (searches.length === MAX_SEARCHES_PER_REQUEST) break;
  }
  return searches;
}

/** Idempotent per model task: a replayed output never queues the same round twice. */
export async function queueSourceRequests(sql: Sql, ctx: Pick<ResearchRunContext, "runId" | "assetId" | "assetSlug">,
  stageKey: string, role: TeamRole, taskKey: string, searches: SourceSearch[]) {
  const ledger = await getStageSourceRequests(sql, ctx.runId, stageKey) || { stage_key: stageKey, role, rounds: [] };
  if (ledger.rounds.some(round => round.task_key === taskKey)) return ledger;
  const round = ledger.rounds.length + 1;
  const next: StageSourceRequests = { ...ledger, rounds: [...ledger.rounds, { round, task_key: taskKey, state: "queued",
    requests: searches.map((search, index) => ({ ...search, id: `${stageKey}-${round}-${index + 1}` })) }] };
  await saveStageSourceRequests(sql, ctx, next);
  return next;
}
