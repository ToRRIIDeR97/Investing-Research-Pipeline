/**
 * Files under `storage/` (fetched sources, parses) may be compacted to `<path>.gz` by `scripts/storage-compact.ts`.
 * Rows keep naming the plain path (and its hash stays the hash of the plain bytes), so every reader goes through
 * `readStoredFile`, which reads the plain file or, when it is gone, the gzipped one. Writers keep writing plain files.
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

export const GZ_SUFFIX = ".gz";

/** The stored bytes at `path`, reading `path.gz` when the plain file was compacted. */
export async function readStoredFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return gunzipSync(await readFile(path + GZ_SUFFIX));
  }
}

/** The stored file as UTF-8 text. */
export async function readStoredText(path: string): Promise<string> {
  return (await readStoredFile(path)).toString("utf8");
}

/**
 * Replaces `path` with `path.gz`. The gzip is written to a temporary name, read back and compared byte for byte with
 * the original before it takes the final name and the original is removed, so a failure leaves the plain file.
 */
export async function compressStoredFile(path: string): Promise<{ before: number; after: number }> {
  const original = await readFile(path);
  const zipped = gzipSync(original, { level: 9 });
  const tmp = `${path}${GZ_SUFFIX}.tmp`;
  await writeFile(tmp, zipped);
  const check = gunzipSync(await readFile(tmp));
  if (!check.equals(original)) { await unlink(tmp).catch(() => undefined); throw new Error(`Compressed copy of ${path} did not round-trip`); }
  await rename(tmp, path + GZ_SUFFIX);
  await unlink(path);
  return { before: original.length, after: zipped.length };
}
