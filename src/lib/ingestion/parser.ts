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
    // Create document_parse record
    const parseRows = await sql`
      INSERT INTO document_parses (
        source_document_id, parser_name, parser_version,
        status, warnings_json, output_storage_path, completed_at
      ) VALUES (
        ${params.sourceDocumentId},
        ${params.parserName},
        ${params.parserVersion},
        'completed',
        ${JSON.stringify(params.parseResult.warnings)},
        ${params.storagePath || null},
        NOW()
      )
      RETURNING id
    `;
    const parseId = parseRows[0].id;

    // Store chunks
    for (const chunk of params.parseResult.chunks) {
      await sql`
        INSERT INTO document_chunks (
          source_document_id, document_parse_id, chunk_index,
          section_title, page_start, page_end,
          text, token_count
        ) VALUES (
          ${params.sourceDocumentId},
          ${parseId},
          ${chunk.chunkIndex},
          ${chunk.sectionTitle || null},
          ${chunk.pageStart || null},
          ${chunk.pageEnd || null},
          ${chunk.text},
          ${chunk.tokenCount || null}
        )
      `;
    }

    // Store tables
    for (const table of params.parseResult.tables) {
      await sql`
        INSERT INTO extracted_tables (
          source_document_id, document_parse_id, table_index,
          page_start, page_end, table_title,
          table_json, confidence
        ) VALUES (
          ${params.sourceDocumentId},
          ${parseId},
          ${table.tableIndex},
          ${table.pageStart || null},
          ${table.pageEnd || null},
          ${table.title || null},
          ${JSON.stringify(table.tableJson)},
          ${table.confidence || null}
        )
      `;
    }

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
  const { execFileSync } = await import("child_process");
  const { join } = await import("path");

  const parserScript = join(process.cwd(), "python", "parsers", "docling_parser.py");

  try {
    const output = execFileSync(
      "python3",
      [parserScript, filePath],
      { timeout: 120000, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
    );
    return JSON.parse(output) as ParseResult;
  } catch (error) {
    // If Docling is not available, fall back to basic text extraction
    console.warn("Docling parser not available, using basic extraction:", error);
    return basicTextExtraction(filePath);
  }
}

/**
 * Basic text extraction fallback when Docling is not available.
 */
async function basicTextExtraction(filePath: string): Promise<ParseResult> {
  const { readFile } = await import("fs/promises");

  const content = await readFile(filePath, "utf-8");

  // Split into chunks of ~2000 characters
  const chunkSize = 2000;
  const chunks: ParsedChunk[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push({
      chunkIndex: Math.floor(i / chunkSize),
      text: content.slice(i, i + chunkSize),
      tokenCount: Math.ceil(content.slice(i, i + chunkSize).length / 4),
    });
  }

  return {
    chunks,
    tables: [],
    metadata: { parser: "basic_fallback" },
    warnings: ["Using basic text extraction — Docling not available"],
  };
}
