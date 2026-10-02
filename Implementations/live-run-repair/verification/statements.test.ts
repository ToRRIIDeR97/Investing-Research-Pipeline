import test from "node:test";
import assert from "node:assert/strict";
import { extractFilingStatements, statementObservations } from "../../../src/lib/research/history/filing-statements";

// Independent fixtures: different issuer, periods, tags and layouts than acceptance.
const src = (n: number, published = "2025-05-10", end = "2025-03-31") =>
  ({ id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, url: `https://sec.example/${n}`, published_at: published, period_end: end, metadata_json: { form: "10-Q" } });
const ctx = (id: string, start: string, end: string, member = "") =>
  `<xbrli:context id="${id}">${member ? `<xbrli:entity><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">${member}</xbrldi:explicitMember></xbrli:segment></xbrli:entity>` : ""}<xbrli:period>${start ? `<xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate>` : `<xbrli:instant>${end}</xbrli:instant>`}</xbrli:period></xbrli:context>`;
const head = (year: number, focus: string, end: string, ...contexts: string[]) =>
  `<ix:nonNumeric name="dei:DocumentFiscalYearFocus">${year}</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">${focus}</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">${end}</ix:nonNumeric><xbrli:unit id="u"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>${contexts.join("")}`;
const f = (c: string, name: string, v: string) => `<ix:nonFraction name="${name}" contextRef="${c}" unitRef="u" scale="3">${v}</ix:nonFraction>`;
const tbl = (...cells: [string, string][]) => `<table>${cells.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join("")}</table>`;
const p = (t: string) => `<p>${t}</p>`;
const base = head(2025, "Q1", "2025-03-31", ctx("i", "", "2025-03-31"), ctx("d", "2025-01-01", "2025-03-31"), ctx("seg", "", "2025-03-31", "x:RetailMember"));

test("AC-1: Interim after Consolidated and many blank siblings still find the heading", () => {
  const html = base + p("Consolidated Interim Statements of Financial Position") + p("") + p(" ") + p("") + p("") + p("") + p("") + p("") +
    p("(thousands of euros)") + tbl(["Total assets", f("i", "ifrs-full:Assets", "10")]);
  const [table] = extractFilingStatements(html, src(1));
  assert.equal(table?.statement, "balance");
  assert.equal(table?.identified_by, "heading");
});

test("AC-1: only six non-blank siblings are read before the table", () => {
  const html = base + p("Condensed Consolidated Balance Sheets") + [1, 2, 3, 4, 5, 6, 7].map(n => p(`Explanatory line ${n}`)).join("") +
    tbl(["Total assets", f("i", "ifrs-full:Assets", "10")]);
  assert.deepEqual(extractFilingStatements(html, src(2)), []);
});

test("AC-2: variant tags identify statements; dimensional-only tables are not classified", () => {
  const html = base +
    p("Segment information") + tbl(["Assets", f("seg", "us-gaap:Assets", "4")], ["Liabilities", f("seg", "us-gaap:Liabilities", "1")],
      ["Equity", f("seg", "us-gaap:StockholdersEquity", "3")]) +
    p("Position") + tbl(["Assets", f("i", "us-gaap:Assets", "40")], ["Total liabilities and equity", f("i", "us-gaap:LiabilitiesAndStockholdersEquity", "40")],
      ["Equity incl. NCI", f("i", "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "15")]) +
    p("Results") + tbl(["Net revenue", f("d", "us-gaap:RevenuesNetOfInterestExpense", "12")], ["Net income", f("d", "us-gaap:NetIncomeLoss", "2")],
      ["EPS", f("d", "us-gaap:EarningsPerShareBasic", "0.2")]) +
    p("Cash") + tbl(["Operating", f("d", "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", "3")],
      ["Investing", f("d", "us-gaap:NetCashProvidedByUsedInInvestingActivitiesContinuingOperations", "-1")],
      ["Financing", f("d", "us-gaap:NetCashProvidedByUsedInFinancingActivitiesContinuingOperations", "-1")]);
  const tables = extractFilingStatements(html, src(3));
  assert.deepEqual(tables.map(t => [t.statement, t.identified_by]), [["balance", "xbrl_tags"], ["income", "xbrl_tags"], ["cashflow", "xbrl_tags"]]);
  assert.equal(tables[0].rows[0].cells[1].facts[0].value, 40_000);
});

test("AC-2: only the first qualifying table is used for a missing statement", () => {
  const balance = (v: string) => tbl(["Assets", f("i", "us-gaap:Assets", v)], ["Liabilities", f("i", "us-gaap:Liabilities", "1")],
    ["Equity", f("i", "us-gaap:StockholdersEquity", "1")]);
  const tables = extractFilingStatements(base + p("First") + balance("2") + p("Second") + balance("2"), src(4));
  assert.equal(tables.length, 1);
});

test("AC-3: an unchanged later value keeps restatement version zero and segments stay separate", () => {
  const filing = (n: number, published: string, year: number) => extractFilingStatements(
    head(year, "Q1", `${year}-03-31`, ctx("d", "2024-01-01", "2024-03-31"), ctx("s", "2024-01-01", "2024-03-31", "x:CloudMember")) +
      p("Consolidated Statements of Operations") + tbl(["Revenue", f("d", "us-gaap:Revenues", "50")], ["Cloud revenue", f("s", "us-gaap:Revenues", "20")]),
    src(n, published, `${year}-03-31`));
  const rows = statementObservations([...filing(5, "2024-05-01", 2024), ...filing(6, "2025-05-01", 2025)])
    .filter(o => o.metric_key === "revenue" && o.periodicity === "quarterly");
  assert.equal(rows.length, 2);
  const consolidated = rows.find(o => !o.segment)!;
  assert.equal(consolidated.restatement_version, 0);
  assert.equal(consolidated.source_document_id, src(6).id);
  assert.ok(rows.find(o => o.segment));
});

test("AC-3: two revenue tags in one filing resolve by the documented concept order", () => {
  const tables = extractFilingStatements(base + p("Consolidated Statements of Income") +
    tbl(["Total revenues", f("d", "us-gaap:Revenues", "70")], ["Contract revenue", f("d", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "60")]), src(7));
  const rows = statementObservations(tables).filter(o => o.metric_key === "revenue" && o.periodicity === "quarterly" && !o.segment);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value_numeric, 60_000);
});
