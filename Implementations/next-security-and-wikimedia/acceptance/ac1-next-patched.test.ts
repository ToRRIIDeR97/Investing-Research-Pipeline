// AC-1: Next.js is on the lowest patched 16.x release (16.4.5) or later in the same major, in package.json, the
// lockfile and the installed copy; eslint-config-next moves with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const parts = (v: string) => v.replace(/^[^\d]*/, "").split(/[.-]/).slice(0, 3).map(Number);
const atLeast1645 = (v: string) => { const [a, b, c] = parts(v); return a === 16 && (b > 4 || (b === 4 && c >= 5)); };

test("AC-1: package.json asks for next and eslint-config-next ^16.4.5", () => {
  const pkg = json("package.json");
  assert.equal(pkg.dependencies.next, "^16.4.5");
  assert.equal(pkg.devDependencies["eslint-config-next"], "^16.4.5");
});

test("AC-1: the lockfile pins a patched 16.x next and eslint-config-next", () => {
  const lock = json("package-lock.json");
  assert.ok(atLeast1645(lock.packages["node_modules/next"].version), lock.packages["node_modules/next"].version);
  assert.ok(atLeast1645(lock.packages["node_modules/eslint-config-next"].version));
  assert.ok(atLeast1645(lock.packages[""].dependencies.next));
});

test("AC-1: the installed next is a patched 16.x", () => {
  const installed = json("node_modules/next/package.json").version as string;
  assert.ok(atLeast1645(installed), installed);
});
