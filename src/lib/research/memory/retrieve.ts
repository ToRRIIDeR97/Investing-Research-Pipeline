// Run-scoped passage retrieval with provenance and coverage gaps.
import type postgres from "postgres";
import { ensureDocumentIndexed, MEMORY_PARSER, MEMORY_PARSER_VERSION } from "./indexing";

export interface RetrievalNeed {
  key: string;
  query: string;
  sourceRoles?: string[];
  sourceIds?: string[];
  /** Default 8. */
  maxPassages?: number;
  seedClaimIds?: string[];
  seedArtifactIds?: string[];
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
  reason: "no_documents_for_role" | "no_matching_passages" | "unreadable_pages";
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

export interface RunDocument { id: string; title: string; sourceType: string; role: string | null }

/** Documents linked to a run with their source role (metadata, then role assignment, then source type). */
export async function runDocuments(sql: postgres.Sql, runId: string): Promise<RunDocument[]> {
  const rows = await sql`
    SELECT sd.id, sd.title, sd.source_type,
      COALESCE(NULLIF(sd.metadata_json->>'source_role', ''),
        CASE WHEN sd.metadata_json->>'semanticRole' IN ('earnings_release', 'earnings_exhibit') THEN 'earnings_release'
             WHEN sd.source_type = 'peer_industry_context' THEN 'industry_primary' END,
        (SELECT sra.role FROM source_role_assignments sra WHERE sra.source_document_id = sd.id
          ORDER BY sra.confidence DESC NULLS LAST, sra.assigned_at ASC LIMIT 1),
        CASE WHEN sd.source_type LIKE 'web\\_%' THEN substring(sd.source_type FROM 5)
             WHEN sd.source_type LIKE 'sec\\_filing\\_%' THEN 'regulatory_filing' END) AS role
    FROM source_documents sd
    WHERE sd.research_run_id = ${runId}
       OR sd.id IN (SELECT source_document_id FROM research_run_sources WHERE research_run_id = ${runId})
    ORDER BY sd.id`;
  return rows.map(row => ({ id: String(row.id), title: String(row.title || ""), sourceType: String(row.source_type || ""), role: row.role ? String(row.role) : null }));
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

export async function retrievePassages(sql: postgres.Sql, input: { runId: string; need: RetrievalNeed; embeddings?: unknown }): Promise<RetrievalResult> {
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
  const query = orQuery(need.query);
  const limit = Math.max(1, Math.floor(need.maxPassages ?? 8));
  const rows = query ? await sql`
    WITH q AS (SELECT websearch_to_tsquery('english', ${query}) AS q),
    parses AS (
      SELECT DISTINCT ON (source_document_id) id FROM document_parses
      WHERE source_document_id = ANY(${ids}::uuid[]) AND parser_name = ${MEMORY_PARSER} AND parser_version = ${MEMORY_PARSER_VERSION} AND status = 'completed'
      ORDER BY source_document_id, completed_at DESC NULLS LAST, created_at DESC
    ),
    candidates AS (
      SELECT dc.*, q.q,
        COALESCE((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(COALESCE(dc.metadata_json->'section_path', '[]'::jsonb))), '') AS section_text
      FROM document_chunks dc JOIN parses ON parses.id = dc.document_parse_id CROSS JOIN q
    )
    SELECT id, source_document_id, document_parse_id, chunk_index, section_title, page_start, char_start, char_end, text, metadata_json,
      ts_rank_cd(to_tsvector('english', text), q) AS text_rank,
      to_tsvector('english', section_text) @@ q AS section_match
    FROM candidates
    WHERE to_tsvector('english', text) @@ q OR to_tsvector('english', section_text) @@ q
    ORDER BY section_match DESC, text_rank DESC, source_document_id, chunk_index
    LIMIT ${limit}` : [];
  const documents = new Map(scoped.map(doc => [doc.id, doc]));
  result.passages = rows.map(row => toPassage(row, documents, Number(row.text_rank) + (row.section_match ? 1 : 0), "keyword"));
  if (!result.passages.length) {
    result.gaps.push({ need_key: need.key, reason: "no_matching_passages", ...(need.sourceRoles?.length ? { source_role: need.sourceRoles.join(",") } : {}),
      detail: `No passage in ${scoped.length} document${scoped.length === 1 ? "" : "s"} matched "${need.query}".` });
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
