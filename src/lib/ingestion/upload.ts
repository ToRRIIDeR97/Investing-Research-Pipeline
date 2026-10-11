import { createHash } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import postgres from "postgres";

const STORAGE_ROOT = join(process.cwd(), "storage", "sources");

/** The largest upload accepted, checked before the request body is read (#24). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const STORED_EXTENSIONS = new Set(["pdf", "html", "htm", "txt", "md", "csv", "xlsx", "docx", "json"]);

/** The extension a stored upload gets: the client's, lowercased, if allowlisted; otherwise "bin" (#20). */
export function storedExtension(fileName: string): string {
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  return STORED_EXTENSIONS.has(ext) ? ext : "bin";
}

/** A source URL field must be an absolute http(s) URL without credentials (#20). */
export function isSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value.length <= 2048;
  } catch {
    return false;
  }
}

/**
 * Compute SHA-256 content hash of a buffer.
 */
export function computeHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Store a raw source file and create a source_documents record.
 * Deduplicates by content hash.
 */
export async function ingestSourceFile(params: {
  fileName: string;
  buffer: Buffer;
  mimeType?: string;
  assetId?: string;
  researchRunId?: string;
  sourceType?: string;
  title?: string;
  publisher?: string;
  url?: string;
  publishedAt?: string;
  language?: string;
}): Promise<{ sourceDocumentId: string; isNew: boolean }> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const hash = computeHash(params.buffer);
    const storagePath = `storage/sources/${hash}.${storedExtension(params.fileName)}`;

    // Check for existing document with same hash
    const existing = await sql`
      SELECT id FROM source_documents WHERE file_hash = ${hash} LIMIT 1
    `;

    if (existing.length > 0) {
      if (params.researchRunId) {
        await sql`
          INSERT INTO research_run_sources (
            research_run_id, source_document_id, role, discovery_metadata_json
          ) VALUES (
            ${params.researchRunId}, ${existing[0].id}, 'uploaded_source', '{}'::jsonb
          )
          ON CONFLICT (research_run_id, source_document_id) DO NOTHING
        `;
      }
      return { sourceDocumentId: existing[0].id, isNew: false };
    }

    // Write file to storage
    await mkdir(STORAGE_ROOT, { recursive: true });
    await writeFile(join(process.cwd(), storagePath), params.buffer);

    // Create database record
    const result = await sql`
      INSERT INTO source_documents (
        asset_id, research_run_id, source_type, title, publisher,
        url, file_hash, mime_type, language, storage_path,
        retrieved_at
      ) VALUES (
        ${params.assetId || null},
        ${params.researchRunId || null},
        ${params.sourceType || "uploaded_file"},
        ${params.title || params.fileName},
        ${params.publisher || null},
        ${params.url || null},
        ${hash},
        ${params.mimeType || null},
        ${params.language || "en"},
        ${storagePath},
        NOW()
      )
      RETURNING id
    `;

    if (params.researchRunId) {
      await sql`
        INSERT INTO research_run_sources (
          research_run_id, source_document_id, role, discovery_metadata_json
        ) VALUES (
          ${params.researchRunId}, ${result[0].id}, 'uploaded_source', '{}'::jsonb
        )
        ON CONFLICT (research_run_id, source_document_id) DO NOTHING
      `;
    }
    return { sourceDocumentId: result[0].id, isNew: true };
  } finally {
    await sql.end();
  }
}

/**
 * Get a source document by ID.
 */
export async function getSourceDocument(id: string) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const rows = await sql`
      SELECT * FROM source_documents WHERE id = ${id}
    `;
    return rows[0] || null;
  } finally {
    await sql.end();
  }
}

/**
 * Read the raw file content for a source document.
 */
export async function readSourceFile(storagePath: string): Promise<Buffer> {
  return readFile(join(process.cwd(), storagePath));
}
