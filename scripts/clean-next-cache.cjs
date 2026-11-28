// Deletes Next.js's regenerable caches: .next/cache (build and image cache) and .next/dev (Turbopack's dev cache,
// which grows with every edit). Dry run by default; pass --apply to delete. Stop `npm run dev` first; the next start
// rebuilds what it needs.
//   node scripts/clean-next-cache.cjs [--apply]
const { existsSync, readdirSync, rmSync, statSync } = require("fs");
const { join, resolve } = require("path");

const root = resolve(__dirname, "..", ".next");
const dry = !process.argv.includes("--apply");
const size = (p) => { const s = statSync(p); return s.isDirectory() ? readdirSync(p).reduce((t, e) => t + size(join(p, e)), 0) : s.size; };
let total = 0;
for (const name of ["cache", "dev"]) {
  const dir = join(root, name);
  if (!existsSync(dir)) continue;
  const bytes = size(dir);
  total += bytes;
  console.log(`${dry ? "Would delete" : "Deleting"} .next/${name} (${(bytes / 1024 / 1024).toFixed(0)} MB)`);
  if (!dry) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`${dry ? "Reclaimable" : "Reclaimed"}: ${(total / 1024 / 1024).toFixed(0)} MB${dry ? ". Nothing changed; re-run with --apply to delete." : ""}`);
