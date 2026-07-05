import { createHash } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import postgres from "postgres";

const STORAGE_ROOT = join(process.cwd(), "storage", "sources");

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
    const ext = params.fileName.split(".").pop() || "bin";
    const storagePath = `storage/sources/${hash}.${ext}`;

    // Check for existing document with same hash
    const existing = await sql`
      SELECT id FROM source_documents WHERE file_hash = ${hash} LIMIT 1
    `;

    if (existing.length > 0) {
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
