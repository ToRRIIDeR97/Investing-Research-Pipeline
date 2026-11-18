// Acceptance tests for the report remaster helpers (AC-1, AC-2).
// Run: npx tsx --test Implementations/report-remaster/acceptance/report-helpers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as presentation from "../../../src/lib/research/reporting/presentation.mjs";

const p = presentation as Record<string, any>;

test("AC-1 railName gives a short chapter name from a long title", () => {
  assert.equal(typeof p.railName, "function", "railName is exported");
  const name = p.railName({ id: "executive-judgment", title: "Executive Judgment: Scaled Digital Bank, but Credit, Funding, and Capital Proof Remain Incomplete" });
  assert.equal(name, "Executive Judgment");
  assert.ok(!name.includes(":"));
});

test("AC-1 railName keeps the curated short name when the section id is known", () => {
  assert.equal(p.railName({ id: "moat_test", title: "Moat test: a very long title about the moat" }), "Competitive advantage");
});

test("AC-1 railName caps titles without a separator at 40 characters on a word boundary", () => {
  const name = p.railName({ id: "x", title: "Management, Governance, Capital Allocation, and Per-Share Outcomes" });
  assert.ok(name.length <= 40, `${name} is ${name.length} chars`);
  assert.ok(!/\s$/.test(name));
  assert.ok("Management, Governance, Capital Allocation, and Per-Share Outcomes".startsWith(name.replace(/…$/, "")));
});

test("AC-2 readerText rounds numbers with three or more decimals to two", () => {
  assert.equal(p.readerText("The base 2029 terminal price target is $12.29933, implying"), "The base 2029 terminal price target is $12.30, implying");
});

test("AC-2 readerText leaves percentages, years and two-decimal numbers alone", () => {
  const text = "About 5.98% growth and a 25.17% margin in 2029 at $16.58.";
  assert.equal(p.readerText(text), text);
});
