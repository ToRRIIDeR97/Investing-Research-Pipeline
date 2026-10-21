// Phase 0 of the 2026-10-21 research-depth review: undated evidence, governance filings, the 10-Q window, the
// passage split, team-request search, the cost ledger and flat report tables.
import test from "node:test";
import assert from "node:assert/strict";
import { evidenceNeeds, rolePassageShares, sectionScore, passageScore } from "../src/lib/research/memory";
import { selectResearchFilings } from "../src/lib/research/sources/corpus";
import { mapToSourceRole } from "../src/lib/research/sources/role-coverage";
import { calculateCost, oneHourCacheWriteSurcharge } from "../src/lib/agent-harness/telemetry";
import { requestSearchQuery, ResearchRequest } from "../src/lib/research/team";
import { isPointInTimeRun } from "../src/lib/research/reporting/store";
import { createReport, type ReportArtifact, type ReportInput } from "../src/lib/research/reporting/report";
import { flatTable, MAX_TABLE_ROWS } from "../src/lib/research/reporting/tables";
import { STANDARD_VERSION, type ReportSection } from "../src/lib/research/reporting/contracts";
import { calculateValuationSchedule } from "../src/lib/research/valuation/schedules";

test("undated documents are excluded only from point-in-time runs", () => {
  const created = "2026-10-13T14:36:00Z";
  assert.equal(isPointInTimeRun({ run_type: "deep_dive", source_cutoff_at: "2026-10-13T14:36:31Z", created_at: created }), false);
  assert.equal(isPointInTimeRun({ run_type: "deep_dive", source_cutoff_at: null, created_at: created }), false);
  assert.equal(isPointInTimeRun({ run_type: "deep_dive", source_cutoff_at: "2026-10-13T00:00:00Z", created_at: created }), false, "a same-day cutoff is today");
  assert.equal(isPointInTimeRun({ run_type: "deep_dive", source_cutoff_at: "2024-06-30T00:00:00Z", created_at: created }), true);
  assert.equal(isPointInTimeRun({ run_type: "backtest_only", source_cutoff_at: null, created_at: created }), true);
  assert.equal(isPointInTimeRun(undefined), false);
});

test("the passage budget follows the square root of each role's stored passages and reassigns what a role cannot use", () => {
  // META 4fae0fb1: 17 filings, one aggregator IR page, small macro and market documents.
  const counts = { regulatory_filing: 4602, company_investor_relations: 20, industry_primary: 60, peer_company_primary: 80,
    earnings_release: 40, macro_dataset: 2, market_data: 1 };
  const shares = rolePassageShares(Object.keys(counts), 88, counts);
  assert.equal(Object.values(shares).reduce((a, b) => a + b, 0), 88, "every slot is assigned");
  assert.ok(shares.regulatory_filing >= 40, `filings get ${shares.regulatory_filing}`);
  assert.ok(shares.company_investor_relations <= 6, `the aggregator page gets ${shares.company_investor_relations}`);
  assert.equal(shares.macro_dataset, 2, "a role never gets more than it stores");
  assert.equal(shares.market_data, 1);
  for (const role of ["industry_primary", "peer_company_primary", "earnings_release"]) assert.ok(shares[role] >= 3, role);
  // Without counts the split stays equal.
  assert.deepEqual(rolePassageShares(["a", "b"], 20), { a: 10, b: 10 });

  const needs = evidenceNeeds(Object.keys(counts), { name: "Meta" }, { passageBudget: 128, kpis: ["ad impressions"], rolePassages: counts });
  const byKey = Object.fromEntries(needs.map(need => [need.key, need.maxPassages]));
  assert.equal(byKey.headline_kpis, 32);
  assert.equal(byKey.governance, 8);
  assert.equal(byKey["role:regulatory_filing"], shares.regulatory_filing);
});

test("the governance need searches filings and proxy material for voting control and ownership", () => {
  const governance = evidenceNeeds(["regulatory_filing", "proxy_and_governance", "industry_primary"], { name: "Meta" }).find(need => need.key === "governance")!;
  assert.deepEqual(governance.sourceRoles, ["regulatory_filing", "proxy_and_governance"]);
  assert.match(governance.query, /voting power.*class B.*beneficial ownership/);
  assert.ok(!evidenceNeeds(["industry_primary"], { name: "Meta" }).some(need => need.key === "governance"));
});

test("risk passages on ownership, voting control or named competitors are no longer penalised", () => {
  const ownership = ["PART I", "Item 1A. Risk Factors", "Risks Related to Ownership of Our Class A Common Stock"];
  assert.equal(sectionScore(ownership, "Our Class B common stock has ten votes per share and our Class A common stock has one vote per share."), 3);
  assert.equal(sectionScore(ownership, "Our CEO has control over key decision making as a result of his control of a majority of the voting power."), 3);
  assert.equal(sectionScore(["PART I", "Item 1A. Risk Factors", "Risks Related to Our Product Offerings"],
    "We face competitive products and services, such as TikTok, that have reduced some users' engagement."), 3);
  assert.equal(sectionScore(["Item 1A. Risk Factors", "Results of operations may fluctuate"], "Our results may fluctuate."), -4);
  assert.equal(sectionScore(["PART I", "Competition"]), 2);
  assert.equal(sectionScore(["Note 13. Stockholders' Equity", "Common Stock"]), 2);
  assert.ok(passageScore({ section_path: ownership, text: "Class B common stock has ten votes per share. The holders control the outcome of matters submitted to stockholders." }) > 0);
});

test("domestic issuers fetch the newest proxy statement and up to three ownership schedules as governance sources", () => {
  const selected = selectResearchFilings([
    { form: "10-K", filingDate: "2026-01-30", reportDate: "2025-12-31" },
    { form: "SCHEDULE 13G/A", filingDate: "2026-02-10" },
    { form: "SCHEDULE 13G", filingDate: "2025-11-12" },
    { form: "SC 13D", filingDate: "2024-08-01" },
    { form: "SC 13G", filingDate: "2024-02-14" },
    { form: "DEF 14A", filingDate: "2026-04-17" },
    { form: "DEF 14A", filingDate: "2025-04-18" },
    { form: "DEFA14A", filingDate: "2026-04-17" },
  ], "2021-01-01", "2026-10-01");
  const governance = selected.filter(filing => filing.semanticRole === "proxy_and_governance");
  assert.deepEqual(governance.map(filing => `${filing.form} ${filing.filingDate}`),
    ["DEF 14A 2026-04-17", "SCHEDULE 13G/A 2026-02-10", "SCHEDULE 13G 2025-11-12", "SC 13D 2024-08-01"]);
  // Foreign issuers report ownership in the 20-F instead.
  assert.ok(!selectResearchFilings([{ form: "20-F", filingDate: "2026-03-01" }, { form: "SC 13G", filingDate: "2026-02-01" }], "2021-01-01", "2026-10-01")
    .some(filing => filing.form === "SC 13G"));
  assert.equal(mapToSourceRole("sec_filing_def_14a", "Meta DEF 14A", { source_role: "proxy_and_governance" }), "proxy_and_governance");
});

test("10-Q selection covers every quarter of the 20-quarter window", () => {
  const rows = [];
  for (let year = 2026; year >= 2020; year--) {
    for (const [quarter, filed] of [["09-30", "10-29"], ["06-30", "07-30"], ["03-31", "04-30"]] as const) {
      if (`${year}-${quarter}` <= "2026-06-30") rows.push({ form: "10-Q", reportDate: `${year}-${quarter}`, filingDate: `${year}-${filed}` });
    }
    rows.push({ form: "10-K", reportDate: `${year - 1}-12-31`, filingDate: `${year}-01-30` });
  }
  rows.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
  const quarterly = selectResearchFilings(rows, "2021-04-01", "2026-10-20").filter(filing => filing.form === "10-Q");
  // 2021Q3 to 2026Q2: 20 quarters, 5 of them Q4s from 10-Ks.
  assert.equal(quarterly.length, 15);
  assert.equal(quarterly.at(-1)!.reportDate, "2021-09-30");
  assert.equal(quarterly[0].reportDate, "2026-06-30");
});

test("a team request searches its named document, not the question prose", () => {
  const request = { question: "Management, governance and ownership are not sourced. Obtain the latest proxy statement and officer disclosures.",
    document: "Meta Platforms 2026 proxy statement DEF 14A" };
  assert.equal(requestSearchQuery(request), "Meta Platforms 2026 proxy statement DEF 14A");
  assert.equal(requestSearchQuery({ question: "  Which   peers? " }), "Which peers?");
  assert.ok(ResearchRequest.safeParse({ role: "data", question: "Who controls the voting power?", material: true, needs_sources: true,
    source_role: "proxy_and_governance", document: request.document }).success);
  assert.ok(!ResearchRequest.safeParse({ role: "data", question: "Who controls the voting power?", material: true, needs_sources: true,
    source_role: "proxy_and_governance", document: "x".repeat(201) }).success);
});

test("the cost ledger prices Haiku's long prompts, Opus and Sonnet, and warns about unknown Claude models", () => {
  // Haiku 5.5: $0.10/$0.50 up to 100K prompt tokens, $0.50/$2.50 above.
  assert.equal(calculateCost("claude-haiku-5-5", 100_000, 10_000), 0.015);
  assert.equal(calculateCost("claude-haiku-5-5", 150_000, 10_000), 0.1);
  // Cache reads count toward the prompt and are scaled too: 140K reads at $0.05 plus 10K at $0.50.
  assert.equal(calculateCost("claude-haiku-5-5", 150_000, 0, { cacheReadTokens: 140_000 }), 0.012);
  assert.equal(oneHourCacheWriteSurcharge("claude-haiku-5-5", 100_000, 150_000), oneHourCacheWriteSurcharge("claude-haiku-5-5", 100_000) * 5);
  assert.equal(calculateCost("claude-opus-5-5", 1_000_000, 1_000_000), 24);
  assert.equal(calculateCost("claude-opus-5-5", 1_000_000, 0, { cacheReadTokens: 1_000_000 }), 0.2);
  assert.equal(calculateCost("claude-sonnet-5-5", 1_000_000, 1_000_000), 12);
  assert.equal(calculateCost("claude-sonnet-5-5", 1_000_000, 0, { cacheReadTokens: 1_000_000 }), 0.2);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    calculateCost("claude-future-9", 1000, 1000);
    calculateCost("claude-future-9", 1000, 1000);
    calculateCost("deepseek-unknown", 1000, 1000);
  } finally { console.warn = warn; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No pricing for claude-future-9/);
});

const method = (scenario_type: string) => ({ method: "fcff", method_name: "FCFF DCF", scenario_type, rationale: "r", currency: "USD",
  cash_flow_label: "FCFF", discount_rate: 0.1, years: [2026, 2027, 2028].map(fiscal_year => ({ fiscal_year, cash_flow: 60,
    build: { starting_profit: 50, depreciation_amortization: 20, capital_expenditures: 8, change_in_net_working_capital: 2, other_adjustments: 0 } })),
  terminal: { type: "multiple", metric: "nopat", metric_value: 100, multiple: 10 }, equity_bridge: -50, equity_bridge_explanation: "Net debt.",
  diluted_shares: 10, source_notes: ["n"] });
const tableArtifacts: ReportArtifact[] = [
  { id: "val", artifact_type: "valuation_scenario_set", scope_key: "default", artifact_version: 1, content_json: {
    method_schedules: ["bear", "base", "bull"].map(s => calculateValuationSchedule(method(s))), expected: { return: null, basis: "pv" } } },
  { id: "hist", artifact_type: "historical_record", scope_key: "default", artifact_version: 1, content_json: {
    observations: Array.from({ length: 200 }, (_, i) => ({ metric_key: "revenue", fiscal_year: 2000 + i, value_numeric: i })) } },
];
const table = (path: string) => ({ title: "T", artifact_id: path.startsWith("observations") ? "hist" : "val", path });

test("report tables print flat rows: schedules as years, nested paths and long lists are rejected with a usable path", () => {
  const schedule = flatTable(table("method_schedules.1"), tableArtifacts);
  assert.equal(schedule.rows.length, 3);
  assert.equal(schedule.rows[0]["build.capital_expenditures"], 8, "one nesting level becomes columns");
  assert.ok(Object.values(schedule.rows[0]).every(value => value === null || typeof value !== "object"));
  assert.match(schedule.notes[0], /value_per_share: /);
  assert.throws(() => flatTable(table("method_schedules"), tableArtifacts), /not a list of flat rows.*Request method_schedules\.0 instead/);
  assert.throws(() => flatTable(table("observations"), tableArtifacts), new RegExp(`200 rows; a report table holds at most ${MAX_TABLE_ROWS}`));
  assert.throws(() => flatTable({ ...table(""), artifact_id: "val" }, tableArtifacts), /Request method_schedules instead/);
  assert.deepEqual(flatTable(table("expected"), tableArtifacts).rows, [{ return: null, basis: "pv" }]);
});

const section = (tables: ReportSection["tables"], evidence_ids: string[] = []): ReportSection => ({ id: "valuation", title: "Valuation", purpose: "p",
  coverage: ["valuation"], artifact_ids: ["val"], paragraphs: [{ kind: "analysis", text: "Value.", evidence_ids, artifact_ids: ["val"] }],
  counterevidence: "c", implication: "i", gaps: [], tables });
const reportInput = (tables: ReportSection["tables"], evidence: ReportInput["evidence"] = []): ReportInput => ({
  asset_name: "Co", cutoff: "2026-06-30T00:00:00Z", is_test: true, required_coverage: ["valuation"],
  sections: [section(tables, evidence.map(e => e.id))], coverage: [{ key: "valuation", status: "qualified", rationale: "r", section_ids: ["valuation"] }],
  questions: [], evidence, artifacts: tableArtifacts });

test("new reports render flat tables and undated sources; reports stored under the previous standard re-render unchanged", () => {
  const undated = { id: "e1", claim_text: "c", source_title: "IAB report", url: "https://example.com/iab", published_at: null, location: "Source 1", quote: "q" };
  const report = createReport(reportInput([table("method_schedules.1")], [undated]));
  assert.equal(report.standard_version, STANDARD_VERSION);
  assert.match(report.markdown, /\| fiscal\\_year \| cash\\_flow \| build\.starting\\_profit \|/);
  assert.match(report.markdown, /IAB report\]\(https:\/\/example\.com\/iab\) · undated ·/);
  assert.ok(!/\{"/.test(report.markdown), "no JSON cells");
  assert.throws(() => createReport(reportInput([table("method_schedules")])), /Request method_schedules\.0 instead/);
  // An adaptive-1 document keeps its renderer, so getReportState's integrity check still passes.
  const legacy = { ...reportInput([table("method_schedules")]), standard_version: "asset-framework-2.1-adaptive-1" };
  const rendered = createReport(legacy);
  assert.equal(rendered.standard_version, "asset-framework-2.1-adaptive-1");
  assert.match(rendered.markdown, /\{"/, "the old renderer printed nested values as JSON");
  assert.equal(createReport({ ...legacy, markdown: rendered.markdown } as ReportInput).content_hash, rendered.content_hash);
  // A dated source after the cutoff is still rejected.
  assert.throws(() => createReport(reportInput([], [{ ...undated, published_at: "2026-07-01T00:00:00.000Z" }])), /beyond cutoff/);
});
