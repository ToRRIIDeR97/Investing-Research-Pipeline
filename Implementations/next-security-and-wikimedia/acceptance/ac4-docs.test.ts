// AC-4: the operator can find out why logos are slow and how to fix it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(__dirname, "../../..", path), "utf8");

test("AC-4: docs/operations.md explains the limit, the log line, the note and the fix", () => {
  const ops = read("docs/operations.md");
  const start = ops.indexOf("## Company profiles");
  assert.ok(start >= 0, "no Company profiles section");
  const end = ops.indexOf("\n## ", start + 5);
  const section = ops.slice(start, end < 0 ? undefined : end);
  for (const part of ["WIKIMEDIA_CONTACT", "[company-profiles] Wikimedia lookups are unidentified", "6.5", "0.4", "200", "10 requests a minute", "Still looking up"]) {
    assert.ok(section.includes(part), `operations.md section misses ${part}`);
  }
});

test("AC-4: .env.example explains the value and ships none", () => {
  const env = read(".env.example");
  assert.match(env, /^# WIKIMEDIA_CONTACT=$/m);
  assert.doesNotMatch(env, /^WIKIMEDIA_CONTACT=\S/m);
  const block = env.slice(env.indexOf("# Company logos"), env.indexOf("# COMPANY_PROFILES"));
  for (const part of ["10", "200", "URL", "User-Agent"]) assert.ok(block.includes(part), `.env.example misses ${part}`);
});
