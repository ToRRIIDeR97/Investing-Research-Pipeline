import { z } from "zod/v4";
import type { ResearchRunContext, Sql } from "../run-context";
import { saveReportArtifact } from "../reporting/store";
import { MAX_STAGE_SOURCE_REQUEST_ROUNDS, type TeamRole } from "../team-plan";
import { SOURCE_ROLES, type SourceRole } from "./roles";

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
/** Longest query, in characters, sent to a search engine. */
export const MAX_QUERY_CHARS = 200;
/** Roles whose documents come from other organisations, so a query names them rather than the researched company. */
const EXTERNAL_ROLES = new Set<SourceRole>(["peer_company_primary", "industry_primary", "regulatory_or_government", "macro_dataset"]);
/** Words that name a kind of document; a query that does not name the researched company must contain one. */
const DOCUMENT_TERMS = new Set(["annual", "quarterly", "report", "reports", "filing", "filings", "10-k", "10-q", "20-f", "40-f", "6-k",
  "8-k", "prospectus", "statement", "statements", "results", "earnings", "presentation", "transcript", "statistics", "data", "dataset",
  "survey", "census", "bulletin", "publication", "release", "study", "outlook", "review", "index"]);
/** Tokens a search engine could treat as a URL, address or operator (site:, inurl:, -term, OR); they are dropped. */
const OPERATOR_TOKEN = /:\/\/|^www\.|@|^[-+]|^[\p{L}_]+:|^OR$/u;
const DOMAIN_TOKEN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?:\/\S*)?$/u;

/** Plain search words from model text: no URLs, domains, addresses or operators, only letters, digits and name punctuation. */
function cleanQueryText(text: string): string {
  const words = text.normalize("NFKC").split(/\s+/)
    .filter(word => word && !OPERATOR_TOKEN.test(word) && !DOMAIN_TOKEN.test(word.replace(/[.,;)]+$/, "")))
    .map(word => word.replace(/[^\p{L}\p{N}&.,'"()\/-]/gu, "")).filter(word => /[\p{L}\p{N}]/u.test(word));
  const joined = words.join(" ");
  return (joined.split('"').length - 1) % 2 ? joined.replace(/"/g, "") : joined;
}

const truncateWords = (text: string, limit: number) =>
  text.length <= limit ? text : text.slice(0, limit + 1).replace(/\s+\S*$/, "").trim();

/**
 * The query the collector may send for a model-chosen search, or null when none is safe (issue #27). Model text is
 * reduced to plain words and capped at MAX_QUERY_CHARS. A search for the company's own documents is anchored to it:
 * "Name" SYMBOL is put first unless the query already names it. A search for another organisation's documents must
 * name the company or a kind of document. Idempotent, so a stored query passes through unchanged.
 */
export function constrainSearch<T extends SourceSearch>(search: T, asset: { name: string; symbol: string }): T | null {
  const text = cleanQueryText(search.query);
  const words = new Set(terms(text));
  const nameTerm = terms(asset.name).find(term => term.length >= 3);
  const namesAsset = words.has(asset.symbol.toLowerCase()) || Boolean(nameTerm && words.has(nameTerm));
  if (![...words].some(word => word.length >= 3 && !STOP_WORDS.has(word))) return null;
  if (!namesAsset && EXTERNAL_ROLES.has(search.source_role) && ![...words].some(word => DOCUMENT_TERMS.has(word))) return null;
  const prefix = namesAsset || EXTERNAL_ROLES.has(search.source_role) ? "" : `"${asset.name}" ${asset.symbol} `;
  const query = (prefix + truncateWords(text, MAX_QUERY_CHARS - prefix.length)).trim();
  return query.length >= 5 ? { ...search, query } : null;
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

/** How model-chosen queries are written; constrainSearch enforces it. */
export const SEARCH_QUERY_RULE = `Write each query as plain words of at most ${MAX_QUERY_CHARS} characters: no URLs, domains, email addresses or search operators (site:, inurl:, a leading minus, OR). Queries for the company's own documents are searched with its name; a query for another organisation names it and the document type.`;

export function sourceRequestRule(allowed: boolean): string {
  return allowed
    ? `If a material conclusion depends on a document missing from the corpus, you may add an optional top-level key source_requests alongside the required keys: an array of at most ${MAX_SEARCHES_PER_REQUEST} objects {source_role, query, reason}. Each query must name a specific document or entity to search for (for example a named competitor's latest annual report), never a generic phrase. ${SEARCH_QUERY_RULE} The collector fetches the documents and this task reruns with them; team_context.source_requests.previous lists what earlier requests found. Omit source_requests when the corpus is adequate, and do not repeat a previous query.`
    : "Do not return source_requests: this stage has used its collector rounds. Work with the supplied corpus and record remaining gaps in the output.";
}

/** Valid, constrained requests from a specialist output, excluding queries this stage already asked. */
export function parseSourceRequests(value: unknown, ledger: StageSourceRequests | null,
  asset: { name: string; symbol: string }): SourceSearch[] {
  if (!Array.isArray(value)) return [];
  const asked = new Set((ledger?.rounds || []).flatMap(round => round.requests.map(request => request.query.toLowerCase())));
  const searches: SourceSearch[] = [];
  for (const item of value) {
    const parsed = SourceSearch.safeParse(item);
    const search = parsed.success ? constrainSearch(parsed.data, asset) : null;
    if (!search) continue;
    const key = search.query.toLowerCase();
    if (asked.has(key)) continue;
    asked.add(key);
    searches.push(search);
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
