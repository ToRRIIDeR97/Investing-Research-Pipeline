// Verification tests for the report helpers (AC-1, AC-2), designed separately from the acceptance set.
// Same author as the plan and implementation; not independent or hidden.
// Run: npx tsx --test Implementations/report-remaster/verification/report-helpers.verify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as presentation from "../../../src/lib/research/reporting/presentation.mjs";

const p = presentation as Record<string, any>;

test("AC-1 em dash and spaced hyphen also separate the short name", () => {
  assert.equal(p.railName({ id: "a", title: "Valuation — Scenarios and Downside" }), "Valuation");
  assert.equal(p.railName({ id: "b", title: "Moat - Evidence and Attacks" }), "Moat");
});

test("AC-1 a short title is returned unchanged", () => {
  assert.equal(p.railName({ id: "c", title: "Catalysts and Thesis Breakers" }), "Catalysts and Thesis Breakers");
});

test("AC-1 snake_case in a title is turned into words", () => {
  const name = p.railName({ id: "d", title: "regulatory_compliance" });
  assert.ok(!name.includes("_"), name);
});

test("AC-1 empty or missing title falls back to a readable id", () => {
  const name = p.railName({ id: "unresolved-next-evidence", title: "" });
  assert.ok(name.length > 0 && name.length <= 40);
  assert.ok(!name.includes("-") || name.includes(" "), name);
});

test("AC-2 rounding keeps thousands separators and minus signs", () => {
  assert.equal(p.readerText("Shares of 1,351.9912 million"), "Shares of 1,351.99 million");
  assert.equal(p.readerText("a -25.8217% return"), "a -25.82% return");
});

test("AC-2 values below one and version-like strings are not rounded", () => {
  assert.equal(p.readerText("confidence 0.5512 and v2.0.1"), "confidence 0.5512 and v2.0.1");
});

test("AC-2 rounding half up", () => {
  assert.equal(p.readerText("$10.845 per share"), "$10.85 per share");
});
