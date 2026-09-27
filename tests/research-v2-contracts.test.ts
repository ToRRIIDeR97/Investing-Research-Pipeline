import assert from "node:assert/strict";
import test from "node:test";
import { canonicalResearchKey, contractForProfile, sourceFamiliesPresent } from "../src/lib/research/v2-contracts";
import { selectResearchFilings } from "../src/lib/research/sources/corpus";

test("MELI receives the fintech-platform operating-company overlay", () => {
  const contract = contractForProfile("operating_company", "mercado-libre");
  assert.ok(contract);
  assert.ok(contract.requiredModules.includes("net_interest_margin_after_losses"));
  assert.ok(contract.requiredMetricKeys.includes("loan_book"));
  assert.deepEqual(contract.valuationModelKeys, ["fintech_platform_sotp"]);
});

test("legacy nimal records map to the corrected canonical key", () => {
  assert.equal(canonicalResearchKey("nimal"), "net_interest_margin_after_losses");
});

test("v2 detects substantive source families rather than document counts", () => {
  const families = sourceFamiliesPresent([
    { source_type: "sec_filing_10_q", title: "Quarterly report", publisher: "SEC EDGAR" },
    { source_type: "sec_filing_8_k", title: "Earnings exhibit 99.1", publisher: "Investor Relations" },
    { source_type: "market_data_snapshot", title: "Yahoo market price", publisher: "Yahoo Finance" },
    { source_type: "industry_context", title: "Industry peer review", publisher: "Public industry source" },
  ]);
  assert.ok(families.has("filing"));
  assert.ok(families.has("investor_relations"));
  assert.ok(families.has("market_data"));
  assert.ok(families.has("peer_industry"));
});

test("filing-family selection retains domestic earnings updates and foreign equivalents", () => {
  const domestic = selectResearchFilings([
    { form: "10-K", filingDate: "2026-02-20" },
    { form: "10-Q", filingDate: "2026-05-08" },
    { form: "8-K", filingDate: "2026-05-07", items: "2.02" },
  ], "2021-01-01", "2026-07-11");
  assert.deepEqual(domestic.map((filing) => filing.form), ["10-K", "10-Q", "8-K"]);

  const foreign = selectResearchFilings([
    { form: "20-F", filingDate: "2026-03-01" },
    { form: "6-K", filingDate: "2026-05-01", primaryDocDescription: "Quarterly results" },
  ], "2021-01-01", "2026-07-11");
  assert.deepEqual(foreign.map((filing) => filing.form), ["20-F", "6-K"]);
});
