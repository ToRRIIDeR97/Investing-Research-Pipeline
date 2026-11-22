// Verification: the notice and the User-Agent never leak operator or environment details.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createUnidentifiedNotice, wikimediaUserAgent } from "../../../src/lib/company-profiles/resolve";

const PREFIX = "PragmaResearch/1.0 (";
const SUFFIX = ") undici";

test("V-2: the unidentified notice carries no environment value", () => {
  const saved = { USERNAME: process.env.USERNAME, USER: process.env.USER, COMPUTERNAME: process.env.COMPUTERNAME, WIKIMEDIA_CONTACT: process.env.WIKIMEDIA_CONTACT };
  process.env.USERNAME = "secret-user-name"; process.env.USER = "secret-user-name"; process.env.COMPUTERNAME = "secret-host";
  delete process.env.WIKIMEDIA_CONTACT;
  const lines: string[] = [];
  try { createUnidentifiedNotice((line) => lines.push(line))(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.equal(lines.length, 1);
  assert.ok(!/secret-/.test(lines[0]), lines[0]);
});

test("V-2: the User-Agent is unchanged without a contact and sanitised with one", () => {
  const before = process.env.WIKIMEDIA_CONTACT;
  try {
    delete process.env.WIKIMEDIA_CONTACT;
    assert.equal(wikimediaUserAgent(), "PragmaResearch/1.0 (self-hosted research tool) undici");
    process.env.WIKIMEDIA_CONTACT = "ops@example.org\r\nX-Evil: 1 (a)";
    const ua = wikimediaUserAgent();
    assert.ok(ua.startsWith(PREFIX) && ua.endsWith(SUFFIX), ua);
    assert.ok(!/[\r\n() ]/.test(ua.slice(PREFIX.length, -SUFFIX.length)), ua);
    process.env.WIKIMEDIA_CONTACT = "x".repeat(500);
    assert.ok(wikimediaUserAgent().length <= PREFIX.length + SUFFIX.length + 120);
  } finally {
    if (before === undefined) delete process.env.WIKIMEDIA_CONTACT; else process.env.WIKIMEDIA_CONTACT = before;
  }
});

test("V-2: .env.example ships no WIKIMEDIA_CONTACT value", () => {
  const env = readFileSync(resolve(__dirname, "../../../.env.example"), "utf8");
  assert.doesNotMatch(env, /^\s*WIKIMEDIA_CONTACT\s*=\s*\S/m);
});
