import postgres from "postgres";

/**
 * Parse result from Docling or other parsers.
 */
export interface ParseResult {
  chunks: ParsedChunk[];
  tables: ParsedTable[];
  metadata: Record<string, unknown>;
  warnings: string[];
}

export interface ParsedChunk {
  chunkIndex: number;
  sectionTitle?: string;
  pageStart?: number;
  pageEnd?: number;
  charStart?: number;
  charEnd?: number;
  text: string;
  tokenCount?: number;
}

export interface ParsedTable {
  tableIndex: number;
  pageStart?: number;
  pageEnd?: number;
  title?: string;
  tableJson: Record<string, unknown>;
  confidence?: number;
}

const CHUNK_INSERT_BATCH = 200;

/**
 * Store parsed results (chunks, tables) in the database.
 */
export async function storeParseResults(params: {
  sourceDocumentId: string;
  parserName: string;
  parserVersion: string;
  parseResult: ParseResult;
  storagePath?: string;
}): Promise<{ parseId: string; chunkCount: number; tableCount: number }> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // One transaction, completed last: a failed chunk insert leaves no parse behind, so a retry parses again.
    const parseId = await sql.begin(async (tx) => {
      const [parse] = await tx`
        INSERT INTO document_parses (
          source_document_id, parser_name, parser_version,
          status, warnings_json, output_storage_path
        ) VALUES (
          ${params.sourceDocumentId},
          ${params.parserName},
          ${params.parserVersion},
          'running',
          ${tx.json(params.parseResult.warnings)},
          ${params.storagePath || null}
        )
        RETURNING id
      `;
      // PostgreSQL text rejects NUL.
      const rows = params.parseResult.chunks.map((chunk) => ({
        source_document_id: params.sourceDocumentId,
        document_parse_id: parse.id,
        chunk_index: chunk.chunkIndex,
        section_title: chunk.sectionTitle || null,
        page_start: chunk.pageStart || null,
        page_end: chunk.pageEnd || null,
        char_start: chunk.charStart ?? null,
        char_end: chunk.charEnd ?? null,
        text: chunk.text.replace(/\u0000/g, ""),
        token_count: chunk.tokenCount || null,
      }));
      for (let start = 0; start < rows.length; start += CHUNK_INSERT_BATCH) {
        await tx`INSERT INTO document_chunks ${tx(rows.slice(start, start + CHUNK_INSERT_BATCH), "source_document_id",
          "document_parse_id", "chunk_index", "section_title", "page_start", "page_end", "char_start", "char_end", "text", "token_count")}`;
      }

      for (const table of params.parseResult.tables) {
        await tx`
          INSERT INTO extracted_tables (
            source_document_id, document_parse_id, table_index,
            page_start, page_end, table_title,
            table_json, confidence
          ) VALUES (
            ${params.sourceDocumentId},
            ${parse.id},
            ${table.tableIndex},
            ${table.pageStart || null},
            ${table.pageEnd || null},
            ${table.title || null},
            ${tx.json(table.tableJson as any)},
            ${table.confidence || null}
          )
        `;
      }
      await tx`UPDATE document_parses SET status = 'completed', completed_at = NOW() WHERE id = ${parse.id}`;
      return String(parse.id);
    });

    return {
      parseId,
      chunkCount: params.parseResult.chunks.length,
      tableCount: params.parseResult.tables.length,
    };
  } finally {
    await sql.end();
  }
}

/**
 * Invoke the Docling Python parser on a source file.
 * This calls a Python subprocess that wraps Docling.
 */
export async function invokeDoclingParser(filePath: string): Promise<ParseResult> {
  const { execFile } = await import("child_process");
  const { join } = await import("path");
  const { promisify } = await import("util");

  const parserScript = join(process.cwd(), "python", "parsers", "docling_parser.py");

  try {
    // Asynchronous, so a 2-minute parse doesn't stall every other request (#24).
    const { stdout } = await promisify(execFile)(
      "python3",
      [parserScript, filePath],
      { timeout: 120000, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
    );
    return JSON.parse(stdout) as ParseResult;
  } catch (error) {
    // If Docling is not available, fall back to basic text extraction
    console.warn("Docling parser not available, using basic extraction:", error);
    return basicTextExtraction(filePath);
  }
}

/** A file the fallback can't read as text (PDF, xlsx, docx, any other binary): it needs Docling. */
export class UnparseableUploadError extends Error {}

/**
 * Basic text extraction fallback when Docling is not available. Only UTF-8 text without NUL bytes is
 * accepted; binary content read as UTF-8 would be stored as garbage evidence or rejected by PostgreSQL.
 */
export async function basicTextExtraction(filePath: string): Promise<ParseResult> {
  const { readFile } = await import("fs/promises");

  const bytes = await readFile(filePath);
  let content: string | null = null;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8.
  }
  if (content === null || content.includes("\u0000")) {
    throw new UnparseableUploadError("This file is binary (for example PDF, xlsx or docx) and needs the Docling parser, which is unavailable");
  }

  // Split into chunks of ~2000 characters
  const chunkSize = 2000;
  const chunks: ParsedChunk[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push({
      chunkIndex: Math.floor(i / chunkSize),
      text: content.slice(i, i + chunkSize),
      tokenCount: Math.ceil(content.slice(i, i + chunkSize).length / 4),
      charStart: i,
      charEnd: Math.min(content.length, i + chunkSize),
    });
  }

  return {
    chunks,
    tables: [],
    metadata: { parser: "basic_fallback" },
    warnings: ["Using basic text extraction — Docling not available"],
  };
}
