// Guards the report's reader-facing label and number rules (Implementations/report-remaster).
import { test } from "node:test";
import assert from "node:assert/strict";
import { label, readerText, railName, compactNumber } from "../src/lib/research/reporting/presentation.mjs";
import { formatInUnit } from "../src/lib/research/reporting/plain-english";

test("column labels drop a trailing key and keep acronyms upper case", () => {
  assert.equal(label("driver_key"), "Driver");
  assert.equal(label("process_node_key"), "Process node");
  assert.equal(label("adjusted_ebitda"), "Adjusted EBITDA");
  assert.equal(label("economic_value_or_roi"), "Economic value or ROI");
});

test("reader text rounds raw decimals, keeps percentages and reads forecast years as 2027E", () => {
  assert.equal(readerText("target of $12.29933 for 2027e"), "target of $12.30 for 2027E");
  assert.equal(readerText("5.98% growth and a 25.17% margin"), "5.98% growth and a 25.17% margin");
});

test("rail names are short and never carry a colon", () => {
  const name = railName({ id: "x", title: "Executive Judgment: Scaled Digital Bank, but Credit Proof Remains Incomplete" });
  assert.equal(name, "Executive Judgment");
  assert.ok(railName({ id: "y", title: "Segment Economics, Customer Decisions, and Cash Conversion" }).length <= 40);
});

test("table cells read compactly", () => {
  assert.equal(compactNumber("153,577,000"), "153.6M");
  assert.equal(compactNumber("0.65949"), "0.66");
  assert.equal(compactNumber("9.6%"), "9.6%");
  assert.equal(compactNumber("Insufficient history"), "Insufficient history");
});

test("KPI counts in millions read 16M, not 16 millions", () => {
  assert.equal(formatInUnit(15.8, "millions"), "16M");
  assert.equal(formatInUnit(2.5, "million shares"), "2.5M shares");
  assert.equal(formatInUnit(60801, "USD millions"), "$60.8B");
});
