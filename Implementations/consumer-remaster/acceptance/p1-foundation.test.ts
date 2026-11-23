// P1: AC-1 tokens, AC-2 type, AC-3 labels and page background, AC-4 shell.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { read, uiFiles } from "./support";

const TOKENS: Record<string, string> = {
  "--page": "#F8F8F4", "--tile": "#FFFFFF", "--soft": "#F5F4EF", "--hover": "#F3F2EC", "--line": "#E7E5DF", "--line-soft": "#EEEDE7",
  "--line-strong": "#D6D3CC", "--ink": "#0D1B2A", "--ink-2": "#44403C", "--ink-3": "#78716C", "--ink-4": "#A8A29E", "--navy": "#0A2642",
  "--navy-hover": "#071E33", "--navy-soft": "#EEF1F5", "--navy-2": "#B4C0CC", "--navy-3": "#3D5A78", "--sage": "#75937D",
  "--positive": "#2D7D46", "--critical": "#C9302C", "--caution": "#B8860B",
  "--positive-bg": "#F5F4EF", "--critical-bg": "#F5F4EF", "--caution-bg": "#F5F4EF",
};

test("AC-1: globals.css defines the remaster tokens", () => {
  const css = read("src/app/globals.css");
  for (const [token, value] of Object.entries(TOKENS)) assert.match(css, new RegExp(`${token}:\\s*${value};`, "i"), token);
  assert.match(css, /--radius-card:\s*24px;/);
  assert.match(css, /--radius-pill:\s*999px;/);
});

test("AC-1: palette.ts mirrors the tokens", async () => {
  const { C } = await import("../../../src/components/ui/palette");
  const c = C as Record<string, string>;
  const pairs: [string, string][] = [["ink", "--ink"], ["ink2", "--ink-2"], ["ink3", "--ink-3"], ["ink4", "--ink-4"], ["line", "--line"], ["soft", "--soft"],
    ["tile", "--tile"], ["navy", "--navy"], ["navy2", "--navy-2"], ["navy3", "--navy-3"], ["positive", "--positive"], ["critical", "--critical"], ["caution", "--caution"]];
  for (const [key, token] of pairs) assert.equal(String(c[key]).toUpperCase(), TOKENS[token].toUpperCase(), key);
});

test("AC-1: raw hex colours appear only in the token, palette and logo files", () => {
  const allowed = new Set(["src/app/globals.css", "src/components/ui/palette.ts", "src/components/brand/logo.tsx"]);
  const bad = uiFiles().filter((p) => !allowed.has(p) && /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b(?![\w-])/i
    .test(read(p).replace(/&#\d+;|href="#[^"]*"|`#[^`]*`|'#[^']*'(?=\))/g, "")));
  assert.deepEqual(bad, []);
});

test("AC-2: Plus Jakarta Sans for display, Inter for text and figures", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /Plus\+Jakarta\+Sans|Plus Jakarta Sans/);
  assert.match(css, /--font-sans:\s*"Inter"/);
  assert.match(css, /--font-display:\s*"Plus Jakarta Sans"/);
  assert.match(css, /--font-mono:\s*"Inter"/);
  assert.match(css, /h1,\s*h2,\s*h3\s*\{[^}]*font-family:\s*var\(--font-display\)/);
});

test("AC-2: no monospace or serif face anywhere in the UI", () => {
  const bad = uiFiles().filter((p) => /JetBrains Mono|DM Serif|Georgia/i.test(read(p)));
  assert.deepEqual(bad, []);
});

test("AC-3: no uppercase letter-spaced labels", () => {
  const bad = uiFiles().filter((p) => /text-transform:\s*uppercase|textTransform:\s*["']uppercase|className=["'`][^"'`]*\buppercase\b/.test(read(p)));
  assert.deepEqual(bad, []);
});

test("AC-3: cream page with the diamond grid", () => {
  const css = read("src/app/globals.css");
  const body = css.match(/body\s*\{[^}]*\}/g)?.join("\n") ?? "";
  assert.match(body, /linear-gradient\(45deg/);
  assert.match(body, /linear-gradient\(-45deg/);
});

test("AC-4: shell keeps its landmarks and uses pills", () => {
  const tsx = read("src/components/app-shell.tsx");
  assert.match(tsx, /aria-label="Main"/);
  assert.match(tsx, /aria-current/);
  assert.match(tsx, /role="combobox"/);
  assert.match(tsx, /href="\/research\/new"/);
  const css = read("src/components/app-shell.module.css");
  assert.ok((css.match(/var\(--radius-pill\)/g) ?? []).length >= 3, "nav links, search and Start research are pills");
  const logo = read("src/components/brand/logo.tsx");
  assert.match(logo, /#0A2642/i);
  assert.match(logo, /#75937D/i);
});
