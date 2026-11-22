// AC-1: one palette. Colours live in globals.css tokens and components/ui/palette.ts; no legacy colours or serif face anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(__dirname, "../../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : [p]; });
}
const ui = [...files(join(root, "src/app")), ...files(join(root, "src/components"))].filter((p) => /\.(css|tsx?)$/.test(p));
const rel = (p: string) => relative(root, p).split("\\").join("/");
const allowed = new Set(["src/app/globals.css", "src/components/ui/palette.ts", "src/components/brand/logo.tsx"]);

test("AC-1: globals.css defines the Slate and navy tokens and Inter", () => {
  const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
  for (const [token, value] of Object.entries({ "--page": "#F5F6F8", "--tile": "#FFFFFF", "--line": "#E2E5EA", "--ink": "#111827", "--ink-2": "#4B5563",
    "--navy": "#1E3A5F", "--navy-soft": "#EDF0F4", "--navy-2": "#B9C7D9", "--positive": "#166534", "--positive-bg": "#E6F4EA",
    "--critical": "#B42318", "--critical-bg": "#FDECEC", "--caution": "#7A5300", "--caution-bg": "#FFF4D6" })) {
    assert.match(css, new RegExp(`${token}:\\s*${value};`, "i"), token);
  }
  assert.match(css, /--font-sans:\s*"Inter"/);
});

test("AC-1: no serif display face or legacy colour in any page or component", () => {
  const bad = ui.filter((p) => /DM Serif|--font-display|#0d1b2a|#75937d|#2e5fa3|#1b2838|#1a2a3a/i.test(readFileSync(p, "utf8"))).map(rel);
  assert.deepEqual(bad, []);
});

test("AC-1: raw hex colours appear only in the token and palette files", () => {
  const bad = ui.filter((p) => !allowed.has(rel(p)) && /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b(?![\w-])/i.test(readFileSync(p, "utf8").replace(/&#\d+;|href="#[^"]*"|`#[^`]*`|'#[^']*'(?=\))/g, "")))
    .map(rel);
  assert.deepEqual(bad, []);
});
