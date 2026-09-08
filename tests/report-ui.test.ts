import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_REPORT_SECTIONS,
  RESEARCH_TABS,
  canonicalHeadingAnchor,
  canonicalHeadingNumber,
  safeMarkdownHref,
  tabForCanonicalHeading,
  tabPath,
} from "../src/lib/research/report-ui";

test("research taxonomy covers every canonical report section exactly once", () => {
  assert.equal(CANONICAL_REPORT_SECTIONS.length, 25);
  const numbers = CANONICAL_REPORT_SECTIONS.map(([number]) => number);
  assert.deepEqual(numbers, Array.from({ length: 25 }, (_, index) => index + 1));
  assert.deepEqual(RESEARCH_TABS.map((tab) => tab.slug), ["general", "financials", "valuation", "thesis", "evidence", "backtests", "updates"]);
  assert.equal(tabForCanonicalHeading(17), "valuation");
  assert.equal(tabForCanonicalHeading(23), "backtests");
  assert.equal(tabForCanonicalHeading(999), "general");
});

test("canonical heading helpers preserve stable anchors and tolerate ordinary titles", () => {
  assert.equal(canonicalHeadingNumber("17. Annual bear/base/bull price-target table"), 17);
  assert.equal(canonicalHeadingNumber("## 17) Annual bear/base/bull price-target table"), 17);
  assert.equal(canonicalHeadingNumber("Not a canonical heading"), null);
  assert.equal(canonicalHeadingAnchor(17), "report-section-17");
});

test("workspace Markdown links allow local and HTTP(S) destinations only", () => {
  assert.equal(safeMarkdownHref("/assets/abc/research/general"), "/assets/abc/research/general");
  assert.equal(safeMarkdownHref("#report-section-17"), "#report-section-17");
  assert.equal(safeMarkdownHref("https://example.com/source"), "https://example.com/source");
  assert.equal(safeMarkdownHref("javascript:alert(1)"), null);
  assert.equal(safeMarkdownHref("data:text/html;base64,abc"), null);
  assert.equal(safeMarkdownHref("//external.example/source"), null);
});

test("nested tab paths preserve the selected run", () => {
  assert.equal(tabPath("asset/1", "valuation", "run/2"), "/assets/asset%2F1/research/valuation?run=run%2F2");
  assert.equal(tabPath("asset-1", "general"), "/assets/asset-1/research/general");
});
