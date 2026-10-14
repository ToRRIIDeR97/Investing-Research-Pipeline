// Stores a document's passages as a `research-memory` parse next to its raw chunks.
import type postgres from "postgres";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseDocument } from "./passages";
import { EMBEDDING_BATCH_SIZE, embedTexts, passageEmbeddingText, type EmbeddingProvider } from "./embeddings";

type Sql = postgres.Sql | postgres.TransactionSql;

export const MEMORY_PARSER = "research-memory";
/** Version 2 keeps text-table rows and repeats a split table's header; older parses re-index on first use. */
export const MEMORY_PARSER_VERSION = "2";

export interface IndexResult {
  parseId: string;
  passages: number;
  status: "indexed" | "current" | "unreadable";
  warnings: string[];
}

async function currentParse(sql: Sql, sourceId: string) {
  const [row] = await sql`SELECT dp.id, (SELECT COUNT(*)::int FROM document_chunks dc WHERE dc.document_parse_id = dp.id) AS passages
    FROM document_parses dp WHERE dp.source_document_id = ${sourceId} AND dp.parser_name = ${MEMORY_PARSER}
      AND dp.parser_version = ${MEMORY_PARSER_VERSION} AND dp.status = 'completed'
    ORDER BY dp.completed_at DESC NULLS LAST LIMIT 1`;
  return row ? { parseId: String(row.id), passages: Number(row.passages) } : null;
}

/**
 * Index one document's content. Concurrent callers for the same document serialize on an
 * advisory lock, so a document is indexed once and later calls report it as current.
 */
export async function indexDocumentContent(sql: postgres.Sql, input: { sourceId: string; content: string; mimeType: string; title: string }): Promise<IndexResult> {
  // A document stored again (same hash) is usually indexed already: skip the parse and file write.
  // The locked check below still settles concurrent first indexing.
  const indexed = await currentParse(sql, input.sourceId);
  if (indexed) return { ...indexed, status: "current", warnings: [] };
  // Passages and their offsets live in document_chunks; nothing reads a normalized-text copy, so none is written.
  const parsed = parseDocument(input.content, input.mimeType);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`research-memory:${input.sourceId}`}))`;
    const existing = await currentParse(tx, input.sourceId);
    if (existing) return { ...existing, status: "current" as const, warnings: [] };
    const warnings = parsed.passages.length ? [] : ["The document has no readable text."];
    const [parse] = await tx`INSERT INTO document_parses (source_document_id, parser_name, parser_version, status, warnings_json)
      VALUES (${input.sourceId}, ${MEMORY_PARSER}, ${MEMORY_PARSER_VERSION}, 'running', ${tx.json(warnings)})
      ON CONFLICT (source_document_id, parser_name, parser_version, parse_config_json)
      DO UPDATE SET status = 'running', warnings_json = EXCLUDED.warnings_json, output_storage_path = NULL, completed_at = NULL
      RETURNING id`;
    const parseId = String(parse.id);
    await tx`DELETE FROM document_chunks WHERE document_parse_id = ${parseId}`;
    const rows = parsed.passages.map(passage => ({
      source_document_id: input.sourceId,
      document_parse_id: parseId,
      chunk_index: passage.index,
      section_title: passage.sectionPath.at(-1) || input.title,
      page_start: passage.page,
      page_end: passage.page,
      char_start: passage.charStart,
      char_end: passage.charEnd,
      text: passage.text,
      token_count: Math.ceil(passage.text.length / 4),
      metadata_json: tx.json({ section_path: passage.sectionPath, block_types: passage.blockTypes, parser: MEMORY_PARSER }),
    }));
    for (let start = 0; start < rows.length; start += 200) {
      await tx`INSERT INTO document_chunks ${tx(rows.slice(start, start + 200), "source_document_id", "document_parse_id", "chunk_index",
        "section_title", "page_start", "page_end", "char_start", "char_end", "text", "token_count", "metadata_json")}`;
    }
    // Stored once so retrieval reads the GIN index instead of parsing every passage per query.
    await tx`UPDATE document_chunks SET search_tsv = setweight(to_tsvector('english', COALESCE(metadata_json->'section_path', '[]'::jsonb)), 'A')
      || setweight(to_tsvector('english', text), 'B') WHERE document_parse_id = ${parseId}`;
    await tx`UPDATE document_parses SET status = 'completed', completed_at = NOW() WHERE id = ${parseId}`;
    return { parseId, passages: rows.length, status: "indexed" as const, warnings };
  });
}

async function recordUnreadable(sql: postgres.Sql, sourceId: string, warning: string): Promise<IndexResult> {
  const [parse] = await sql`INSERT INTO document_parses (source_document_id, parser_name, parser_version, status, warnings_json)
    VALUES (${sourceId}, ${MEMORY_PARSER}, ${MEMORY_PARSER_VERSION}, 'failed', ${sql.json([warning])})
    ON CONFLICT (source_document_id, parser_name, parser_version, parse_config_json)
    DO UPDATE SET status = CASE WHEN document_parses.status = 'completed' THEN document_parses.status ELSE 'failed' END,
      warnings_json = CASE WHEN document_parses.status = 'completed' THEN document_parses.warnings_json ELSE EXCLUDED.warnings_json END
    RETURNING id`;
  return { parseId: String(parse.id), passages: 0, status: "unreadable", warnings: [warning] };
}

/**
 * Store a vector for every passage of a parse that has none for the provider's model. A refused
 * budget or a failed call stops embedding for this document; the parse keeps its keyword index
 * and records the failure in its warnings.
 */
export async function embedParse(sql: postgres.Sql, input: { parseId: string; sourceId: string; runId?: string; embeddings: EmbeddingProvider }): Promise<string[]> {
  const { embeddings } = input;
  const missing = await sql`SELECT dc.id, dc.text, dc.metadata_json->'section_path' AS section_path FROM document_chunks dc
    WHERE dc.document_parse_id = ${input.parseId}
      AND NOT EXISTS (SELECT 1 FROM document_embeddings de WHERE de.document_chunk_id = dc.id AND de.embedding_model = ${embeddings.model})
    ORDER BY dc.chunk_index`;
  for (let start = 0; start < missing.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = missing.slice(start, start + EMBEDDING_BATCH_SIZE);
    const texts = batch.map(row => passageEmbeddingText(Array.isArray(row.section_path) ? row.section_path.map(String) : [], String(row.text)));
    let vectors: number[][];
    try {
      vectors = await embedTexts(embeddings, texts, { runId: input.runId, purpose: "passages", sourceId: input.sourceId });
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      await sql`UPDATE document_parses SET warnings_json = COALESCE(warnings_json, '[]'::jsonb) || ${sql.json([warning])}
        WHERE id = ${input.parseId} AND NOT COALESCE(warnings_json, '[]'::jsonb) @> ${sql.json([warning])}`;
      return [warning];
    }
    const rows = batch.map((row, i) => ({ document_chunk_id: row.id, embedding_model: embeddings.model,
      embedding_dimension: vectors[i].length, embedding: sql.json(vectors[i]) }));
    await sql`INSERT INTO document_embeddings ${sql(rows, "document_chunk_id", "embedding_model", "embedding_dimension", "embedding")}
      ON CONFLICT (document_chunk_id, embedding_model) DO NOTHING`;
  }
  return [];
}

/**
 * Index a stored document from its file when it has no current `research-memory` parse. With an
 * embedding provider, passages that lack a vector for its model get one, also on a document that
 * was indexed earlier without embeddings.
 */
export async function ensureDocumentIndexed(sql: postgres.Sql, input: { sourceId: string; runId?: string; embeddings?: EmbeddingProvider | null }): Promise<IndexResult> {
  const result = await indexStoredDocument(sql, input.sourceId);
  if (!input.embeddings || result.status === "unreadable" || !result.passages) return result;
  const warnings = await embedParse(sql, { parseId: result.parseId, sourceId: input.sourceId, runId: input.runId, embeddings: input.embeddings });
  return { ...result, warnings: [...result.warnings, ...warnings] };
}

async function indexStoredDocument(sql: postgres.Sql, sourceId: string): Promise<IndexResult> {
  const existing = await currentParse(sql, sourceId);
  if (existing) return { ...existing, status: "current", warnings: [] };
  const [doc] = await sql`SELECT id, storage_path, mime_type, title FROM source_documents WHERE id = ${sourceId}`;
  if (!doc) throw new Error(`Source document ${sourceId} does not exist`);
  const storageRoot = resolve(process.cwd(), "storage");
  const path = resolve(process.cwd(), String(doc.storage_path || ""));
  if (!doc.storage_path || !path.startsWith(storageRoot + sep)) {
    return recordUnreadable(sql, sourceId, `The stored file path ${String(doc.storage_path || "(none)")} is outside the source storage folder.`);
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    return recordUnreadable(sql, sourceId, `The stored file could not be read: ${(error as NodeJS.ErrnoException).code || (error as Error).message}.`);
  }
  return indexDocumentContent(sql, { sourceId, content, mimeType: String(doc.mime_type || "text/plain"), title: String(doc.title || "") });
}
