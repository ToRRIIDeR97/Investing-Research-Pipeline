// Verifier support (independent of acceptance/support.ts): CSS modules resolve to class names.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const ext = (require as unknown as { extensions: Record<string, (m: { exports: unknown }) => void> }).extensions;
ext[".css"] = (m) => { m.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : k === "default" ? m.exports : String(k)) }); };
export const root = join(__dirname, "../../..");
export const read = (p: string) => readFileSync(join(root, p), "utf8");
