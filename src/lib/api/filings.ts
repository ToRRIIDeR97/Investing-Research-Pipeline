/**
 * The filings library's server side: an asset's stored primary filings, a filing's outline, one section's text and
 * the plain-text download. Read only. Everything comes from database rows (`source_documents` and the passages in
 * `document_chunks`); no path or URL from the client is ever read, and a document must belong to one of the asset's
 * runs (or carry the asset's id) to be served.
 */
import { pipelineSql } from "@/db/pipeline-sql";
import { ApiError } from "@/lib/api/errors";
import { MEMORY_PARSER, MEMORY_PARSER_VERSION } from "@/lib/research/memory/indexing";
import { FILING_FORMS, compressFiling, filingForm, filingText, recentFilings, sectionText, type FilingChunk } from "@/lib/research/filings/library";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Candidate documents read per asset before the library's own filter. */
const MAX_CANDIDATES = 500;
/** Passages read per filing, and the characters kept, so one request stays bounded. */
const MAX_CHUNKS = 20_000;
const MAX_TEXT_CHARS = 8_000_000;
const PREVIEW_CHARS = 400;

export function filingId(id: string, what = "Filing") {
  if (!UUID.test(id)) throw new ApiError(`${what} not found`, 404, "NOT_FOUND");
  return id;
}

export async function requireFilingsAsset(assetId: string) {
  filingId(assetId, "Asset");
  const [row] = await pipelineSql()`SELECT id FROM assets WHERE id = ${assetId}`;
  if (!row) throw new ApiError("Asset not found", 404, "NOT_FOUND");
  return String(row.id);
}

type DocRow = { id: string; source_type: string; title: string; url: string | null; published_at: string | null; retrieved_at: string;
  period_end: string | null; metadata_json: Record<string, unknown> | null };

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value ? new Date(String(value)).toISOString() : null;
const toDoc = (r: Record<string, any>): DocRow => ({ id: String(r.id), source_type: String(r.source_type), title: String(r.title ?? ""), url: r.url ? String(r.url) : null,
  published_at: iso(r.published_at), retrieved_at: iso(r.retrieved_at) ?? new Date(0).toISOString(), period_end: iso(r.period_end),
  metadata_json: r.metadata_json && typeof r.metadata_json === "object" ? r.metadata_json as Record<string, unknown> : null });

/**
 * The asset's own filing documents: attached to one of its runs (directly or through research_run_sources) or
 * carrying its id; SEC filings and earnings materials only (peer documents are other companies'), never a failed
 * download.
 */
async function assetFilingRows(assetId: string, documentId?: string) {
  const sql = pipelineSql();
  const rows = await sql`SELECT sd.id, sd.source_type, sd.title, sd.url, sd.published_at, sd.retrieved_at, sd.period_end, sd.metadata_json
    FROM source_documents sd
    WHERE ${documentId ? sql`sd.id = ${documentId}` : sql`TRUE`}
      AND (sd.asset_id = ${assetId}
        OR sd.research_run_id IN (SELECT id FROM research_runs WHERE asset_id = ${assetId})
        OR EXISTS (SELECT 1 FROM research_run_sources rrs JOIN research_runs r ON r.id = rrs.research_run_id
          WHERE rrs.source_document_id = sd.id AND r.asset_id = ${assetId}))
      AND (sd.source_type LIKE 'sec\\_filing\\_%' OR sd.source_type IN ('regulatory_filing', 'earnings_release'))
      AND COALESCE(sd.metadata_json->>'fetch_status', '') <> 'failed'
    ORDER BY sd.published_at DESC NULLS LAST, sd.retrieved_at DESC
    LIMIT ${MAX_CANDIDATES}`;
  return rows.map(toDoc);
}

/** The asset's primary filings from the last two years, newest first, with whether their text is stored. */
export async function listFilings(assetId: string, now = new Date()) {
  const filings = recentFilings(await assetFilingRows(assetId), now);
  const ids = filings.map((f) => f.id);
  const readable = new Set(ids.length ? (await pipelineSql()`SELECT DISTINCT dp.source_document_id FROM document_parses dp
    WHERE dp.source_document_id = ANY(${ids}::uuid[]) AND dp.status = 'completed'
      AND EXISTS (SELECT 1 FROM document_chunks dc WHERE dc.document_parse_id = dp.id)`).map((r) => String(r.source_document_id)) : []);
  return filings.map((f) => ({ id: f.id, form: f.form, title: f.title, url: f.url, published_at: f.published_at, period_end: f.period_end, has_text: readable.has(f.id) }));
}

/** One of the asset's filings (any date), or 404: the ownership check every filing route and filing note makes. */
export async function requireFilingOfAsset(assetId: string, documentId: string) {
  filingId(documentId);
  const [doc] = await assetFilingRows(assetId, documentId);
  const form = doc ? filingForm(doc) : null;
  if (!doc || !form || !(FILING_FORMS as readonly string[]).includes(form)) throw new ApiError("Filing not found", 404, "NOT_FOUND");
  return { ...doc, form };
}

/**
 * The filing's stored passages: the research-memory parse (passages with section titles) when there is one, else the
 * newest completed parse's chunks. Bounded in rows and characters.
 */
async function filingChunks(documentId: string): Promise<{ chunks: FilingChunk[]; truncated: boolean; parser: string | null }> {
  const sql = pipelineSql();
  const [parse] = await sql`SELECT id, parser_name FROM document_parses dp WHERE dp.source_document_id = ${documentId} AND dp.status = 'completed'
      AND EXISTS (SELECT 1 FROM document_chunks dc WHERE dc.document_parse_id = dp.id)
    ORDER BY (dp.parser_name = ${MEMORY_PARSER} AND dp.parser_version = ${MEMORY_PARSER_VERSION}) DESC, (dp.parser_name = ${MEMORY_PARSER}) DESC,
      dp.completed_at DESC NULLS LAST LIMIT 1`;
  if (!parse) return { chunks: [], truncated: false, parser: null };
  const rows = await sql`SELECT chunk_index, section_title, text FROM document_chunks WHERE document_parse_id = ${parse.id}
    ORDER BY chunk_index LIMIT ${MAX_CHUNKS + 1}`;
  let total = 0, truncated = rows.length > MAX_CHUNKS;
  const chunks: FilingChunk[] = [];
  for (const row of rows.slice(0, MAX_CHUNKS)) {
    const text = String(row.text ?? "");
    if (total + text.length > MAX_TEXT_CHARS) { truncated = true; break; }
    total += text.length;
    chunks.push({ chunk_index: Number(row.chunk_index), section_title: row.section_title ? String(row.section_title) : null, text });
  }
  return { chunks, truncated, parser: String(parse.parser_name) };
}

const describe = (doc: Awaited<ReturnType<typeof requireFilingOfAsset>>) =>
  ({ id: doc.id, form: doc.form, title: doc.title, url: doc.url, published_at: doc.published_at, period_end: doc.period_end });

/** The outline: the filing, its sections (title, size, preview) and the totals. */
export async function filingOutline(assetId: string, documentId: string) {
  const doc = await requireFilingOfAsset(assetId, documentId);
  const { chunks, truncated } = await filingChunks(doc.id);
  return { filing: describe(doc), has_text: chunks.length > 0, truncated, ...compressFiling(chunks, PREVIEW_CHARS) };
}

/** One section's full text. */
export async function filingSection(assetId: string, documentId: string, section: string) {
  if (!/^\d{1,5}$/.test(section)) throw new ApiError("Section not found", 404, "NOT_FOUND");
  const doc = await requireFilingOfAsset(assetId, documentId);
  const { chunks } = await filingChunks(doc.id);
  const index = Number(section);
  const text = sectionText(chunks, index);
  if (text === null) throw new ApiError("Section not found", 404, "NOT_FOUND");
  const outline = compressFiling(chunks, 0).sections[index];
  return { filing: describe(doc), index, title: outline.title, text };
}

/** The plain-text download and a safe file name. */
export async function filingDownload(assetId: string, documentId: string) {
  const doc = await requireFilingOfAsset(assetId, documentId);
  const { chunks } = await filingChunks(doc.id);
  if (!chunks.length) throw new ApiError("This filing's text is not stored yet.", 404, "NO_TEXT");
  const date = (doc.published_at ?? "").slice(0, 10);
  const name = `${doc.form}${date ? `-${date}` : ""}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return { text: filingText(doc.title, chunks), filename: `${name}.txt` };
}
