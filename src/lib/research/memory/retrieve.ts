// Run-scoped passage retrieval with provenance and coverage gaps.
import type postgres from "postgres";
import { ensureDocumentIndexed, MEMORY_PARSER, MEMORY_PARSER_VERSION } from "./indexing";
import { cosineSimilarity, embedTexts, type EmbeddingProvider } from "./embeddings";
import { graphPassages } from "./graph";

export interface RetrievalNeed {
  key: string;
  query: string;
  sourceRoles?: string[];
  sourceIds?: string[];
  /** Default 8. */
  maxPassages?: number;
  seedClaimIds?: string[];
  seedArtifactIds?: string[];
  /** Keyword search matches any of these phrases instead of any word of `query` (which still drives vector ranking). */
  phrases?: string[];
}

export interface RetrievedPassage {
  passage_id: string;
  source_id: string;
  parse_id: string;
  source_role: string | null;
  title: string;
  section_path: string[];
  page: number | null;
  chunk_index: number;
  char_start: number;
  char_end: number;
  text: string;
  score: number;
  matched: "keyword" | "vector" | "both" | "graph";
}

export interface CoverageGap {
  need_key: string;
  reason: "no_documents_for_role" | "no_matching_passages" | "no_documents_for_period" | "unreadable_pages";
  source_role?: string;
  source_id?: string;
  pages?: number[];
  detail: string;
}

export interface RetrievalResult {
  need_key: string;
  passages: RetrievedPassage[];
  gaps: CoverageGap[];
  ranking: "keyword" | "hybrid";
}

export interface RunDocument {
  id: string; title: string; sourceType: string; role: string | null;
  /** YYYY-MM-DD, or null when unknown. */
  periodEnd: string | null;
  publishedAt: string | null;
}

/**
 * Documents linked to a run with their source role: this run's discovery metadata first, then the
 * document's, then role assignment, then source type. A document deduplicated across runs keeps the
 * first run's row, so the title and role this run stored win. Only the newest document per URL is
 * kept. The SEC companyfacts context (primary_source_context) is left out: its data is read from the
 * raw payload, and its pretty-printed JSON would crowd filing passages out of the regulatory scope.
 */
export async function runDocuments(sql: postgres.Sql, runId: string): Promise<RunDocument[]> {
  const rows = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (COALESCE(sd.url, sd.id::text)) sd.id, sd.source_type,
        COALESCE(NULLIF(meta.json->>'title', ''), sd.title) AS title,
        to_char(sd.period_end, 'YYYY-MM-DD') AS period_end,
        to_char(sd.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS published_at,
        COALESCE(NULLIF(meta.json->>'source_role', ''),
          CASE WHEN meta.json->>'semanticRole' IN ('earnings_release', 'earnings_exhibit') THEN 'earnings_release'
               WHEN sd.source_type = 'peer_industry_context' THEN 'industry_primary' END,
          (SELECT sra.role FROM source_role_assignments sra WHERE sra.source_document_id = sd.id
            ORDER BY sra.confidence DESC NULLS LAST, sra.assigned_at ASC LIMIT 1),
          CASE WHEN sd.source_type LIKE 'web\\_%' THEN substring(sd.source_type FROM 5)
               WHEN sd.source_type LIKE 'sec\\_filing\\_%' THEN 'regulatory_filing' END) AS role
      FROM source_documents sd
      LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id AND rrs.research_run_id = ${runId}
      CROSS JOIN LATERAL (SELECT CASE WHEN COALESCE(rrs.discovery_metadata_json, '{}'::jsonb) = '{}'::jsonb
        THEN sd.metadata_json ELSE rrs.discovery_metadata_json END AS json) meta
      WHERE (sd.research_run_id = ${runId} OR rrs.id IS NOT NULL) AND sd.source_type <> 'primary_source_context'
      ORDER BY COALESCE(sd.url, sd.id::text), sd.created_at DESC, sd.id
    ) docs ORDER BY id`;
  return rows.map(row => ({ id: String(row.id), title: String(row.title || ""), sourceType: String(row.source_type || ""), role: row.role ? String(row.role) : null,
    periodEnd: row.period_end ? String(row.period_end) : null, publishedAt: row.published_at ? String(row.published_at) : null }));
}

function scopedDocuments(documents: RunDocument[], need: RetrievalNeed): RunDocument[] {
  return documents.filter(doc => (!need.sourceIds?.length || need.sourceIds.includes(doc.id))
    && (!need.sourceRoles?.length || (doc.role !== null && need.sourceRoles.includes(doc.role))));
}

/** Index any scoped document that lacks a current research-memory parse. */
async function ensureIndexed(sql: postgres.Sql, ids: string[], runId: string) {
  if (!ids.length) return;
  const indexed = new Set((await sql`SELECT DISTINCT source_document_id FROM document_parses
    WHERE source_document_id = ANY(${ids}::uuid[]) AND parser_name = ${MEMORY_PARSER} AND parser_version = ${MEMORY_PARSER_VERSION}
      AND status = 'completed'`).map(row => String(row.source_document_id)));
  for (const id of ids) if (!indexed.has(id)) await ensureDocumentIndexed(sql, { sourceId: id, runId });
}

/** Free-text need queries match any of their words. */
const orQuery = (query: string) => query.split(/[\s,;]+/).map(term => term.replace(/["()]/g, "").trim()).filter(Boolean).join(" OR ");
/**
 * websearch_to_tsquery syntax: each phrase must match as consecutive words; any phrase may match. Every phrase is
 * quoted, so a leading "-" or a word "or" in it is text, not a NOT or OR operator.
 */
export const phraseQuery = (phrases: string[]) => phrases.map(phrase => phrase.replace(/["()]/g, " ").replace(/\s+/g, " ").trim())
  .filter(Boolean).map(phrase => `"${phrase}"`).join(" OR ");

export interface PeriodHint { label: string; start: string; end: string }

const QUARTER_END = ["03-31", "06-30", "09-30", "12-31"];
const fullYear = (year: string) => year.length === 2 ? `20${year}` : year;
const quarter = (label: string, q: string, year: string): PeriodHint =>
  ({ label, start: `${fullYear(year)}-${String((Number(q) - 1) * 3 + 1).padStart(2, "0")}-01`, end: `${fullYear(year)}-${QUARTER_END[Number(q) - 1]}` });

/**
 * Periods a query names: ISO dates, quarters ("Q2 2026", "Q2'26", "2Q26") and years ("2025", "FY2025").
 * A form number is not a year: "the Q2 10-Q" names no period.
 */
export function periodHints(query: string): PeriodHint[] {
  const hints: PeriodHint[] = [];
  const rest = query
    .replace(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g, (label) => { hints.push({ label, start: label, end: label }); return " "; })
    .replace(/\bQ([1-4])\s*(?:FY\s*)?'?((?:19|20)\d{2}|\d{2})\b(?!-)/gi, (label, q, year) => { hints.push(quarter(label, q, year)); return " "; })
    .replace(/\b([1-4])Q\s*'?((?:19|20)\d{2}|\d{2})\b(?!-)/gi, (label, q, year) => { hints.push(quarter(label, q, year)); return " "; });
  for (const [, year] of rest.matchAll(/(?:^|\D)((?:19|20)\d{2})(?!\d)/g)) hints.push({ label: year, start: `${year}-01-01`, end: `${year}-12-31` });
  return hints.filter((hint, index) => hints.findIndex(other => other.start === hint.start && other.end === hint.end) === index);
}

/** Days after a period's end in which a document dated by filing or publication (an earnings release) still reports on it. */
const REPORTING_LAG_DAYS = 45;
const afterLag = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + REPORTING_LAG_DAYS);
  return day.toISOString().slice(0, 10);
};

/**
 * Dates a document reporting on the period can carry. A date runs to REPORTING_LAG_DAYS after it. A quarter
 * or year starts REPORTING_LAG_DAYS late too: a release filed in its first weeks reports on the period before.
 */
const periodWindow = (hint: PeriodHint) => ({ from: hint.start === hint.end ? hint.start : afterLag(hint.start), until: afterLag(hint.end) });

/** Whether a document's period end (or, without one, its publication date) falls in the period's window. */
export function coversPeriod(doc: Pick<RunDocument, "periodEnd" | "publishedAt">, hint: PeriodHint): boolean {
  const date = doc.periodEnd || doc.publishedAt;
  if (!date) return false;
  const { from, until } = periodWindow(hint);
  return date >= from && date <= until;
}

/** Newest first: period end, then publication date; documents without dates last. */
const byRecency = (a: RunDocument | undefined, b: RunDocument | undefined) =>
  (b?.periodEnd || "").localeCompare(a?.periodEnd || "") || (b?.publishedAt || "").localeCompare(a?.publishedAt || "");

/**
 * Section and opening words with digits and punctuation removed, so the same note restated in another
 * filing has the same key. A passage left with under 60 letters (a table of numbers) is never treated
 * as a copy; statement tables whose labels match are.
 */
const copyKey = (c: { row: Record<string, any> }) => {
  const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
  const words = normal(String(c.row.text));
  if (words.length < 60) return `passage:${c.row.id}`;
  const section = Array.isArray(c.row.metadata_json?.section_path) ? String(c.row.metadata_json.section_path.at(-1) ?? "") : "";
  return `${normal(section)}|${words.slice(0, 150)}`;
};

function toPassage(row: Record<string, any>, documents: Map<string, RunDocument>, score: number, matched: RetrievedPassage["matched"]): RetrievedPassage {
  const doc = documents.get(String(row.source_document_id));
  return {
    passage_id: String(row.id),
    source_id: String(row.source_document_id),
    parse_id: String(row.document_parse_id),
    source_role: doc?.role ?? null,
    title: doc?.title || String(row.section_title || ""),
    section_path: Array.isArray(row.metadata_json?.section_path) ? row.metadata_json.section_path.map(String) : [],
    page: row.page_start === null || row.page_start === undefined ? null : Number(row.page_start),
    chunk_index: Number(row.chunk_index),
    char_start: Number(row.char_start ?? 0),
    char_end: Number(row.char_end ?? 0),
    text: String(row.text),
    score,
    matched,
  };
}

/** Reciprocal rank fusion constant. */
const RRF_K = 60;

/** Competition ranks ("1224"): equal keys share a rank, so ties stay ties after fusion. */
function competitionRanks<T>(items: T[], key: (item: T) => string): Map<T, number> {
  const ranks = new Map<T, number>();
  items.forEach((item, index) => {
    const previous = items[index - 1];
    ranks.set(item, index > 0 && key(previous) === key(item) ? ranks.get(previous)! : index + 1);
  });
  return ranks;
}

/** Latest completed research-memory parse of each document. */
async function latestParses(sql: postgres.Sql, ids: string[]): Promise<string[]> {
  return (await sql`SELECT DISTINCT ON (source_document_id) id FROM document_parses
    WHERE source_document_id = ANY(${ids}::uuid[]) AND parser_name = ${MEMORY_PARSER} AND parser_version = ${MEMORY_PARSER_VERSION} AND status = 'completed'
    ORDER BY source_document_id, completed_at DESC NULLS LAST, created_at DESC`).map(row => String(row.id));
}

/**
 * Passages nearest the query by cosine similarity, using only vectors of the provider's model.
 * Vectors are streamed in batches and only their scores are kept, so a large corpus is never
 * held in memory at once. Null when no passage in scope has such a vector or the query could
 * not be embedded.
 */
async function vectorRanking(sql: postgres.Sql, input: { runId: string; parseIds: string[]; query: string; embeddings: EmbeddingProvider; depth: number }) {
  if (!input.query.trim()) return null;
  const [{ present }] = await sql`SELECT EXISTS (SELECT 1 FROM document_chunks dc
    JOIN document_embeddings de ON de.document_chunk_id = dc.id AND de.embedding_model = ${input.embeddings.model}
    WHERE dc.document_parse_id = ANY(${input.parseIds}::uuid[])) AS present`;
  if (!present) return null;
  let queryVector: number[];
  try {
    [queryVector] = await embedTexts(input.embeddings, [input.query], { runId: input.runId, purpose: "query" });
  } catch {
    return null;
  }
  const scored: Array<{ id: string; doc: string; chunk: number; similarity: number }> = [];
  await sql`SELECT dc.id, dc.source_document_id, dc.chunk_index, de.embedding FROM document_chunks dc
    JOIN document_embeddings de ON de.document_chunk_id = dc.id AND de.embedding_model = ${input.embeddings.model}
    WHERE dc.document_parse_id = ANY(${input.parseIds}::uuid[])`.cursor(500, rows => {
    for (const row of rows) {
      const similarity = Array.isArray(row.embedding) ? cosineSimilarity(queryVector, row.embedding as number[]) : 0;
      if (similarity > 0) scored.push({ id: String(row.id), doc: String(row.source_document_id), chunk: Number(row.chunk_index), similarity });
    }
  });
  return scored
    .sort((a, b) => b.similarity - a.similarity || a.doc.localeCompare(b.doc) || a.chunk - b.chunk)
    .slice(0, input.depth);
}

interface Candidate {
  row: Record<string, any>;
  keywordRank?: number;
  vectorRank?: number;
  sectionMatch: boolean;
  textRank: number;
  graph?: { seed: boolean };
}

/**
 * Passages for one need from the run's documents in scope. Documents covering a period the query
 * names (a date, quarter or year) come first, and a named period no document covers is reported as
 * a gap once reports on it can exist. Keyword relevance ranks passages whose section path matches
 * above body-only matches. With an embedding provider and stored vectors for its model, keyword and
 * vector rankings are fused (RRF, k = 60). Ties go to the newest document, and a note restated in
 * several filings keeps one copy for each period asked for, or else the newest copy. Seed claims and
 * artifacts add the passages holding them and their one-hop neighbours; a graph link breaks relevance
 * ties, and graph-only passages take up to half of the slots after the relevance matches.
 */
export async function retrievePassages(sql: postgres.Sql, input: { runId: string; need: RetrievalNeed; embeddings?: EmbeddingProvider | null }): Promise<RetrievalResult> {
  const { need } = input;
  const all = await runDocuments(sql, input.runId);
  const scoped = scopedDocuments(all, need);
  const result: RetrievalResult = { need_key: need.key, passages: [], gaps: [], ranking: "keyword" };
  if (!scoped.length) {
    result.gaps.push({ need_key: need.key, reason: "no_documents_for_role", ...(need.sourceRoles?.length ? { source_role: need.sourceRoles.join(",") } : {}),
      detail: need.sourceRoles?.length ? `The run has no documents for ${need.sourceRoles.join(", ")}.` : "The run has no documents in scope." });
    return result;
  }
  const ids = scoped.map(doc => doc.id);
  await ensureIndexed(sql, ids, input.runId);
  const parseIds = await latestParses(sql, ids);
  const query = need.phrases?.length ? phraseQuery(need.phrases) : orQuery(need.query);
  const limit = Math.max(1, Math.floor(need.maxPassages ?? 8));
  const depth = Math.max(limit * 5, 50);
  // Documents for the periods the query names are searched first; the rest of the scope fills what is left.
  const hints = periodHints(need.query);
  const periodIds = scoped.filter(doc => hints.some(hint => coversPeriod(doc, hint))).map(doc => doc.id);
  // search_tsv holds the section path (weight A) and the text (weight B); an A match is a section match.
  const keywordRows = query && parseIds.length ? await sql`
    WITH q AS (SELECT websearch_to_tsquery('english', ${query}) AS q)
    SELECT dc.id, dc.source_document_id, dc.document_parse_id, dc.chunk_index, dc.section_title, dc.page_start, dc.char_start, dc.char_end, dc.text, dc.metadata_json,
      dc.source_document_id = ANY(${periodIds}::uuid[]) AS in_period,
      ts_rank_cd(dc.search_tsv, q.q) AS text_rank,
      ts_filter(dc.search_tsv, '{a}') @@ q.q AS section_match
    FROM document_chunks dc CROSS JOIN q JOIN source_documents sd ON sd.id = dc.source_document_id
    WHERE dc.document_parse_id = ANY(${parseIds}::uuid[]) AND dc.search_tsv @@ q.q
    ORDER BY in_period DESC, section_match DESC, text_rank DESC, sd.period_end DESC NULLS LAST, sd.published_at DESC NULLS LAST, dc.source_document_id, dc.chunk_index
    LIMIT ${depth}` : [];
  const vectors = input.embeddings && parseIds.length
    ? await vectorRanking(sql, { runId: input.runId, parseIds, query: need.query, embeddings: input.embeddings, depth })
    : null;
  const graph = await graphPassages(sql, { parseIds, seedClaimIds: need.seedClaimIds, seedArtifactIds: need.seedArtifactIds });

  const candidates = new Map<string, Candidate>();
  const keywordKey = (row: Record<string, any>) => `${row.in_period ? 1 : 0}:${row.section_match ? 1 : 0}:${Number(row.text_rank)}`;
  const keywordRanks = competitionRanks(keywordRows as Record<string, any>[], keywordKey);
  for (const row of keywordRows) {
    candidates.set(String(row.id), { row, keywordRank: keywordRanks.get(row), sectionMatch: Boolean(row.section_match), textRank: Number(row.text_rank) });
  }
  if (vectors) {
    const vectorRanks = competitionRanks(vectors, item => String(item.similarity));
    for (const item of vectors) {
      const candidate = candidates.get(item.id) || { row: {}, sectionMatch: false, textRank: 0 };
      candidates.set(item.id, { ...candidate, vectorRank: vectorRanks.get(item) });
    }
  }
  for (const link of graph) {
    const candidate = candidates.get(link.passageId) || { row: {}, sectionMatch: false, textRank: 0 };
    candidates.set(link.passageId, { ...candidate, graph: { seed: link.seed } });
  }
  const missingRows = [...candidates].filter(([, candidate]) => !candidate.row.id).map(([id]) => id);
  if (missingRows.length) {
    for (const row of await sql`SELECT id, source_document_id, document_parse_id, chunk_index, section_title, page_start, char_start, char_end, text, metadata_json
      FROM document_chunks WHERE id = ANY(${missingRows}::uuid[])`) candidates.get(String(row.id))!.row = row;
  }

  const hybrid = vectors !== null;
  result.ranking = hybrid ? "hybrid" : "keyword";
  const documents = new Map(scoped.map(doc => [doc.id, doc]));
  const docOf = (c: Candidate) => documents.get(String(c.row.source_document_id));
  const inPeriod = (c: Candidate) => periodIds.includes(String(c.row.source_document_id));
  const fused = (c: Candidate) => (c.keywordRank ? 1 / (RRF_K + c.keywordRank) : 0) + (c.vectorRank ? 1 / (RRF_K + c.vectorRank) : 0);
  const score = (c: Candidate) => hybrid ? fused(c) : c.textRank + (c.sectionMatch ? 1 : 0);
  // Ties go to the newest filing, then document order.
  const byPosition = (a: Candidate, b: Candidate) => byRecency(docOf(a), docOf(b))
    || String(a.row.source_document_id).localeCompare(String(b.row.source_document_id)) || Number(a.row.chunk_index) - Number(b.row.chunk_index);
  const ranked = [...candidates.values()].filter(c => c.keywordRank || c.vectorRank).sort((a, b) =>
    Number(inPeriod(b)) - Number(inPeriod(a))
    || (hybrid ? fused(b) - fused(a) : Number(b.sectionMatch) - Number(a.sectionMatch) || b.textRank - a.textRank)
    || Number(Boolean(b.graph)) - Number(Boolean(a.graph)) || byPosition(a, b));
  // The same note restated in several filings takes one slot per period asked for (the newest copy covering it),
  // or, when no filing from a period asked for has it, one slot for the newest copy.
  const periodsOf = (c: Candidate) => { const doc = docOf(c); return doc ? hints.filter(hint => coversPeriod(doc, hint)).map(hint => hint.label).join(",") : ""; };
  const groupOf = (c: Candidate) => `${copyKey(c)}|${periodsOf(c)}`;
  const copyOwner = new Map<string, Candidate>();
  for (const c of ranked) {
    const owner = copyOwner.get(groupOf(c));
    if (!owner || byPosition(c, owner) < 0) copyOwner.set(groupOf(c), c);
  }
  const periodCopies = new Set([...copyOwner.values()].filter(inPeriod).map(copyKey));
  const relevance = ranked.filter(c => (inPeriod(c) || !periodCopies.has(copyKey(c)))
    && String(copyOwner.get(groupOf(c))!.row.source_document_id) === String(c.row.source_document_id));
  const graphOnly = [...candidates.values()].filter(c => !c.keywordRank && !c.vectorRank && c.graph)
    .sort((a, b) => Number(Boolean(b.graph?.seed)) - Number(Boolean(a.graph?.seed)) || byPosition(a, b));
  const head = relevance.slice(0, limit - Math.min(graphOnly.length, Math.ceil(limit / 2)));
  const chosen = [...head, ...graphOnly.slice(0, limit - head.length)];

  const matchOf = (c: Candidate): RetrievedPassage["matched"] =>
    c.keywordRank && c.vectorRank ? "both" : c.keywordRank ? "keyword" : c.vectorRank ? "vector" : "graph";
  result.passages = chosen.map(c => toPassage(c.row, documents, score(c), matchOf(c)));
  if (!result.passages.length) {
    result.gaps.push({ need_key: need.key, reason: "no_matching_passages", ...(need.sourceRoles?.length ? { source_role: need.sourceRoles.join(",") } : {}),
      detail: `No passage in ${scoped.length} document${scoped.length === 1 ? "" : "s"} matched "${need.query}".` });
  }
  // A period no document could report on yet (a maturity or target year) is not missing.
  const today = new Date().toISOString().slice(0, 10);
  const missedPeriods = hints.filter(hint => periodWindow(hint).from <= today && !scoped.some(doc => coversPeriod(doc, hint))).map(hint => hint.label);
  if (missedPeriods.length) {
    result.gaps.push({ need_key: need.key, reason: "no_documents_for_period", ...(need.sourceRoles?.length ? { source_role: need.sourceRoles.join(",") } : {}),
      detail: `No document in scope covers ${missedPeriods.join(", ")}.` });
  }
  return result;
}

/** The first passages of each document, for roles whose need matched nothing. */
export async function openingPassages(sql: postgres.Sql, input: { runId: string; sourceIds: string[]; perDocument: number }): Promise<RetrievedPassage[]> {
  if (!input.sourceIds.length) return [];
  await ensureIndexed(sql, input.sourceIds, input.runId);
  const documents = new Map((await runDocuments(sql, input.runId)).map(doc => [doc.id, doc]));
  const rows = await sql`
    WITH parses AS (
      SELECT DISTINCT ON (source_document_id) id FROM document_parses
      WHERE source_document_id = ANY(${input.sourceIds}::uuid[]) AND parser_name = ${MEMORY_PARSER} AND parser_version = ${MEMORY_PARSER_VERSION} AND status = 'completed'
      ORDER BY source_document_id, completed_at DESC NULLS LAST, created_at DESC
    )
    SELECT dc.* FROM document_chunks dc JOIN parses ON parses.id = dc.document_parse_id
    WHERE dc.chunk_index < ${input.perDocument}
    ORDER BY dc.source_document_id, dc.chunk_index`;
  return rows.map(row => toPassage(row, documents, 0, "keyword"));
}
