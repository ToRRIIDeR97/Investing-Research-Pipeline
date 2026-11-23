// Test support: CSS modules resolve to their class names, and helpers to walk the UI tree.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ext = (require as unknown as { extensions: Record<string, (m: { exports: unknown }) => void> }).extensions;
ext[".css"] = (m) => { m.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : k === "default" ? m.exports : String(k)) }); };

export const root = join(__dirname, "../../..");
export const read = (p: string) => readFileSync(join(root, p), "utf8");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : [p]; });
}
export const rel = (p: string) => relative(root, p).split("\\").join("/");
/** Every CSS, TS and TSX file under src/app and src/components, repository-relative. */
export const uiFiles = () => [...files(join(root, "src/app")), ...files(join(root, "src/components"))].filter((p) => /\.(css|tsx?)$/.test(p)).map(rel);
