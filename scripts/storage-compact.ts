// Storage compaction. Dry run by default: prints how many source files would be gzipped and the bytes involved.
//   npx tsx scripts/storage-compact.ts [--storage <dir>] [--min-age-days 7] [--apply]
// Rows keep their plain storage_path and file_hash; readers fall back to <path>.gz (src/lib/storage/stored-file.ts).
// See docs/operations.md.
import { join, resolve } from "path";
import { applyCompaction, planCompaction } from "../src/lib/maintenance/storage-compact";

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const apply = process.argv.includes("--apply");
  const minAgeDays = Number(option("--min-age-days") ?? 7);
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) throw new Error("--min-age-days must be a number of days");
  const root = resolve(option("--storage") ?? "storage");
  const plan = await planCompaction([join(root, "sources"), join(root, "parses")], { minAgeMs: minAgeDays * 86_400_000 });
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${plan.candidates.length} files (${mb(plan.bytes)}) to gzip in ${root}; ${plan.tooNew} newer than ${minAgeDays} days kept; ${plan.skipped} small or binary skipped.`);
  if (!apply) { console.log("Nothing changed. Re-run with --apply to compress them."); return; }
  const result = await applyCompaction(plan);
  console.log(`Compressed ${result.files} files: ${mb(result.before)} → ${mb(result.after)} (saved ${mb(result.before - result.after)}).`);
  if (result.failed.length) console.log(`Left alone (round-trip check failed): ${result.failed.length}\n  ${result.failed.slice(0, 10).join("\n  ")}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
