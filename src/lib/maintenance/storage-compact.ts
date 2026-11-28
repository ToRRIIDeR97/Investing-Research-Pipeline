// Storage compaction: gzip fetched source files at rest. Filings (HTML) and companyfacts (JSON) shrink 5–10×.
// Rows keep naming the plain path; readers use readStoredFile (src/lib/storage/stored-file.ts), which falls back to
// <path>.gz. Planning only reads. scripts/storage-compact.ts applies the plan only with --apply.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { compressStoredFile, GZ_SUFFIX } from "../storage/stored-file";

/** Text-like files worth compressing; PDFs and images are already compressed. */
const COMPRESSIBLE = /\.(html?|json|txt|csv|xml|xbrl|md)$/i;
const MIN_BYTES = 4096;

export type CompactCandidate = { path: string; bytes: number };
export type CompactPlan = { candidates: CompactCandidate[]; bytes: number; tooNew: number; skipped: number };

/** Files under `dirs` that are text-like, at least 4 KB, not yet compacted and older than `minAgeMs`. */
export async function planCompaction(dirs: string[], options: { minAgeMs: number; now?: number }): Promise<CompactPlan> {
  const now = options.now ?? Date.now();
  const plan: CompactPlan = { candidates: [], bytes: 0, tooNew: 0, skipped: 0 };
  for (const dir of dirs) {
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (name.startsWith(".") || name.endsWith(GZ_SUFFIX) || name.endsWith(`${GZ_SUFFIX}.tmp`)) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || !COMPRESSIBLE.test(name) || info.size < MIN_BYTES) { plan.skipped += 1; continue; }
      if (now - info.mtimeMs < options.minAgeMs) { plan.tooNew += 1; continue; }
      plan.candidates.push({ path, bytes: info.size });
      plan.bytes += info.size;
    }
  }
  return plan;
}

/** Compresses each planned file; a file that changed or vanished since planning is left alone. */
export async function applyCompaction(plan: CompactPlan): Promise<{ files: number; before: number; after: number; failed: string[] }> {
  const out = { files: 0, before: 0, after: 0, failed: [] as string[] };
  for (const c of plan.candidates) {
    const info = await stat(c.path).catch(() => null);
    if (!info || info.size !== c.bytes) continue;
    try {
      const r = await compressStoredFile(c.path);
      out.files += 1; out.before += r.before; out.after += r.after;
    } catch {
      out.failed.push(c.path);
    }
  }
  return out;
}
