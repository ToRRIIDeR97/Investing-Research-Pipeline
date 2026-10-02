import test from "node:test";
import assert from "node:assert/strict";
import { extractFilingStatements, filingCoverage, statementObservations } from "../../../src/lib/research/history/filing-statements";
import { reconcileAnnualToQuarters } from "../../../src/lib/research/history/reconciliation";
import { takeLatestRestatement } from "../../../src/lib/research/history/normalizer";
import { HistoricalObservation } from "../../../src/lib/research/history/contracts";
import { context, docId, fact, header, row, source, spacer, standardStatements, table, text } from "./fixtures";

const quarter = (contexts = context("i", "", "2026-06-30") + context("q", "2026-04-01", "2026-06-30")) =>
  header(2026, "Q2", "2026-06-30", contexts);

test("AC-1: MELI-style headings across spacer tables, blank siblings, dashes, Interim and singular Statement", () => {
  const heading = (name: string) =>
    text(`Acme, Inc. - Interim Condensed Consolidated ${name.replace("Statements", "Statement")}`) +
    `<p></p><p> </p>` + text("(In millions of U.S. dollars) (Unaudited)") + spacer;
  const tables = extractFilingStatements(quarter() + standardStatements(heading), source(docId(1), "2026-08-01", "2026-06-30"));
  assert.deepEqual(tables.map(t => t.statement), ["balance", "income", "cashflow"]);
  assert.ok(tables.every(t => t.identified_by === "heading"));
  assert.equal(filingCoverage(tables, [source(docId(1), "2026-08-01", "2026-06-30")])[0].status, "extracted");
});

test("AC-1: a table containing text still ends the heading search", () => {
  const html = quarter() + text("Consolidated Balance Sheets") +
    table(row("Unrelated note with values", "12")) +
    table(row("Segment assets", fact("i", "acme:SegmentAssets", "4")));
  assert.deepEqual(extractFilingStatements(html, source(docId(2), "2026-08-01", "2026-06-30")), []);
});

test("AC-2: statements without readable headings are identified by their XBRL tags", () => {
  const heading = (name: string) => text(`Financial report part ${name.length}`);
  const tables = extractFilingStatements(quarter() + standardStatements(heading), source(docId(3), "2026-08-01", "2026-06-30"));
  assert.deepEqual(tables.map(t => [t.statement, t.identified_by]),
    [["balance", "xbrl_tags"], ["income", "xbrl_tags"], ["cashflow", "xbrl_tags"]]);
});

test("AC-2: a heading-identified statement is never replaced and partial fingerprints are ignored", () => {
  const html = quarter() +
    text("Consolidated Statements of Income") +
    table(row("Revenue", fact("q", "us-gaap:Revenues", "90")), row("Net income", fact("q", "us-gaap:NetIncomeLoss", "9"))) +
    text("Note 7 - Revenue by segment") +
    table(row("Revenue", fact("q", "us-gaap:Revenues", "90")), row("Net income", fact("q", "us-gaap:NetIncomeLoss", "9")),
      row("EPS", fact("q", "us-gaap:EarningsPerShareBasic", "1.5", "eps"))) +
    text("Note 8 - Liquidity") +
    table(row("Assets", fact("i", "us-gaap:Assets", "500")), row("Liabilities", fact("i", "us-gaap:Liabilities", "300")));
  const tables = extractFilingStatements(html, source(docId(4), "2026-08-01", "2026-06-30"));
  assert.deepEqual(tables.map(t => [t.statement, t.identified_by]), [["income", "heading"]]);
});

test("AC-3: recast quarters under a different tag replace the original filing's values", () => {
  const original = extractFilingStatements(
    header(2023, "Q1", "2023-03-31", context("q1", "2023-01-01", "2023-03-31")) + text("Consolidated Statements of Income") +
      table(row("Net revenues", fact("q1", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "3,037"))),
    source(docId(5), "2023-05-04", "2023-03-31"));
  const recast = extractFilingStatements(
    header(2024, "Q1", "2024-03-31", context("q1", "2023-01-01", "2023-03-31")) + text("Consolidated Statements of Income") +
      table(row("Net revenues and financial income", fact("q1", "us-gaap:Revenues", "3,186"))),
    source(docId(6), "2024-05-03", "2024-03-31"));
  const revenue = takeLatestRestatement(statementObservations([...original, ...recast]).map(o => HistoricalObservation.parse(o)))
    .filter(o => o.metric_key === "revenue" && o.fiscal_year === 2023 && o.fiscal_quarter === 1 && o.periodicity === "quarterly");
  assert.equal(revenue.length, 1);
  assert.equal(revenue[0].value_numeric, 3_186_000_000);
  assert.equal(revenue[0].restatement_version, 1);
  assert.equal(revenue[0].source_document_id, docId(6));
});

test("AC-3: a fiscal year of recast quarters reconciles to the recast annual figure", () => {
  const quarters = [["2023-01-01", "2023-03-31", "3,037", "3,186"], ["2023-04-01", "2023-06-30", "3,415", "3,585"],
    ["2023-07-01", "2023-09-30", "3,760", "3,927"]];
  const filings = quarters.flatMap(([start, end, oldValue, newValue], i) => [
    extractFilingStatements(header(2023, `Q${i + 1}`, end, context("q", start, end)) + text("Consolidated Statements of Income") +
      table(row("Net revenues", fact("q", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", oldValue))),
      source(docId(10 + i), `2023-0${5 + i}-01`, end)),
    extractFilingStatements(header(2024, `Q${i + 1}`, end.replace("2023", "2024"), context("q", start, end)) +
      text("Consolidated Statements of Income") + table(row("Net revenues and financial income", fact("q", "us-gaap:Revenues", newValue))),
      source(docId(20 + i), `2024-0${5 + i}-01`, end.replace("2023", "2024"))),
  ]).flat();
  const annual = extractFilingStatements(header(2025, "FY", "2025-12-31", context("y", "2023-01-01", "2023-12-31")) +
    text("Consolidated Statements of Income") + table(row("Net revenues and financial income", fact("y", "us-gaap:Revenues", "15,107"))),
    source(docId(30), "2026-02-25", "2025-12-31", "10-K"));
  const q3ytd = extractFilingStatements(header(2024, "Q3", "2024-09-30", context("ytd", "2023-01-01", "2023-09-30")) +
    text("Consolidated Statements of Income") + table(row("Net revenues and financial income", fact("ytd", "us-gaap:Revenues", "10,698"))),
    source(docId(31), "2024-11-07", "2024-09-30"));
  const observations = takeLatestRestatement(statementObservations([...filings, ...q3ytd, ...annual]).map(o => HistoricalObservation.parse(o)));
  const fy2023 = observations.filter(o => o.metric_key === "revenue" && o.fiscal_year === 2023 && o.periodicity === "quarterly");
  assert.deepEqual(fy2023.map(o => o.value_numeric! / 1e6).sort((a, b) => a - b), [3186, 3585, 3927, 4409]);
  assert.deepEqual(reconcileAnnualToQuarters(observations), []);
});
