import { NextRequest } from "next/server";
import { db } from "@/db";
import { research_runs } from "@/db/schema/workflow";
import { research_run_sources, source_documents } from "@/db/schema/corpus";
import { handleApiError, createdResponse, ApiError } from "@/lib/api/errors";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { document_parses } from "@/db/schema/corpus";
import { invokeDoclingParser, storeParseResults, UnparseableUploadError } from "@/lib/ingestion/parser";
import { isSourceUrl, MAX_UPLOAD_BYTES, storedExtension } from "@/lib/ingestion/upload";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: runId } = await params;

    // Verify the research run exists
    const [run] = await db
      .select({ id: research_runs.id, asset_id: research_runs.asset_id })
      .from(research_runs)
      .where(eq(research_runs.id, runId))
      .limit(1);

    if (!run) {
      throw new ApiError("Research run not found", 404, "NOT_FOUND");
    }

    // Refuse an oversized or unsized body before reading it (#24).
    const declaredBytes = request.headers.get("content-length");
    if (!declaredBytes || Number(declaredBytes) > MAX_UPLOAD_BYTES) {
      throw new ApiError(`Uploads need a Content-Length of at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413, "UPLOAD_TOO_LARGE");
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const sourceType = formData.get("source_type")?.toString() || "upload";
    const url = formData.get("url")?.toString().trim() || undefined;
    if (url && !isSourceUrl(url)) {
      throw new ApiError("url must be an http or https URL without credentials", 400, "INVALID_URL");
    }

    // URL-only source — no file required
    if (sourceType === "url" && (!file || !(file instanceof File))) {
      if (!url) {
        throw new ApiError("No URL provided", 400, "MISSING_URL");
      }

      const urlHash = createHash("sha256").update(url).digest("hex");

      // Check for existing document with same URL hash (deduplication — §6.2)
      const [existingUrl] = await db
        .select()
        .from(source_documents)
        .where(eq(source_documents.file_hash, urlHash))
        .limit(1);

      if (existingUrl) {
        if (!existingUrl.research_run_id) {
          await db
            .update(source_documents)
            .set({ research_run_id: runId })
            .where(eq(source_documents.id, existingUrl.id));
        }
        await linkToRun(runId, existingUrl.id);
        await parseSourceIfNeeded(existingUrl.id, existingUrl.storage_path);
        return createdResponse(existingUrl);
      }

      const [sourceDoc] = await db
        .insert(source_documents)
        .values({
          asset_id: run.asset_id,
          research_run_id: runId,
          source_type: "url",
          title: formData.get("title")?.toString() || url,
          file_hash: urlHash,
          mime_type: null,
          storage_path: `url:${url}`,
          publisher: formData.get("publisher")?.toString() || null,
          author: formData.get("author")?.toString() || null,
          url,
          language: formData.get("language")?.toString() || null,
        })
        .returning();

      await linkToRun(runId, sourceDoc.id);
      return createdResponse(sourceDoc);
    }

    if (!file || !(file instanceof File)) {
      throw new ApiError("No file provided in form data", 400, "MISSING_FILE");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ApiError(`Uploads are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413, "UPLOAD_TOO_LARGE");
    }

    // Read file content as buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Compute SHA-256 hash
    const hash = createHash("sha256").update(buffer).digest("hex");

    // Lowercased and allowlisted; anything else is stored as .bin
    const originalName = file.name || "unknown";
    const ext = storedExtension(originalName);

    // Ensure storage directory exists
    const storageDir = join(process.cwd(), "storage", "sources");
    await mkdir(storageDir, { recursive: true });

    // Write file to storage
    const storageFilename = `${hash}.${ext}`;
    const storagePath = join(storageDir, storageFilename);
    await writeFile(storagePath, buffer);

    // Check for existing document with same hash (deduplication — §6.2)
    const [existing] = await db
      .select()
      .from(source_documents)
      .where(eq(source_documents.file_hash, hash))
      .limit(1);

    if (existing) {
      // Link existing document to this run if not already linked
      if (!existing.research_run_id) {
        await db
          .update(source_documents)
          .set({ research_run_id: runId })
          .where(eq(source_documents.id, existing.id));
      }
      // Another run may hold the document; this run sees it through its own link.
      await linkToRun(runId, existing.id);
      await parseSourceIfNeeded(existing.id, existing.storage_path);
      return createdResponse(existing);
    }

    // Create source_documents record
    const [sourceDoc] = await db
      .insert(source_documents)
      .values({
        asset_id: run.asset_id,
        research_run_id: runId,
        source_type: formData.get("source_type")?.toString() || "upload",
        title: formData.get("title")?.toString() || originalName,
        file_hash: hash,
        mime_type: file.type || null,
        storage_path: `storage/sources/${storageFilename}`,
        publisher: formData.get("publisher")?.toString() || null,
        author: formData.get("author")?.toString() || null,
        url: url || null,
        language: formData.get("language")?.toString() || null,
      })
      .returning();

    await linkToRun(runId, sourceDoc.id);
    await parseSourceIfNeeded(sourceDoc.id, sourceDoc.storage_path);

    return createdResponse(sourceDoc);
  } catch (error) {
    if (error instanceof UnparseableUploadError) {
      return handleApiError(new ApiError(error.message, 422, "UNPARSEABLE_UPLOAD"));
    }
    return handleApiError(error);
  }
}

async function linkToRun(runId: string, sourceDocumentId: string) {
  await db
    .insert(research_run_sources)
    .values({ research_run_id: runId, source_document_id: sourceDocumentId, role: "uploaded_source" })
    .onConflictDoNothing();
}

async function parseSourceIfNeeded(sourceDocumentId: string, storagePath: string) {
  if (storagePath.startsWith("url:")) {
    return null;
  }

  // Only a completed parse counts; a failed one is retried by the next upload.
  const [existingParse] = await db
    .select({ id: document_parses.id })
    .from(document_parses)
    .where(and(eq(document_parses.source_document_id, sourceDocumentId), eq(document_parses.status, "completed")))
    .limit(1);

  if (existingParse) {
    return null;
  }

  const parseResult = await invokeDoclingParser(join(process.cwd(), storagePath));
  return storeParseResults({
    sourceDocumentId,
    parserName: parseResult.metadata.parser === "basic_fallback" ? "basic_fallback" : "docling",
    parserVersion: String(parseResult.metadata.version || "unknown"),
    parseResult,
  });
}
