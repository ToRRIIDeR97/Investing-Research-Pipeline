// P2: AC-4..AC-9 companyfacts from the XBRL warehouse, with SEC fallback.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fact, stubFetch, submissions } from "./support";

const mod = () => import("../../../src/lib/research/history/xbrl-warehouse");
const UA = "Pragma Research test@example.com";
const BASE = "http://127.0.0.1:8080";
const env = { XBRL_WAREHOUSE_URL: BASE } as unknown as NodeJS.ProcessEnv;

test("AC-4: warehouseUrlFromEnv", async () => {
  const { warehouseUrlFromEnv } = await mod();
  assert.equal(warehouseUrlFromEnv({} as NodeJS.ProcessEnv), null);
  assert.equal(warehouseUrlFromEnv({ XBRL_WAREHOUSE_URL: "  " } as unknown as NodeJS.ProcessEnv), null);
  assert.equal(warehouseUrlFromEnv(env)?.hostname, "127.0.0.1");
  assert.throws(() => warehouseUrlFromEnv({ XBRL_WAREHOUSE_URL: "https://example.com" } as unknown as NodeJS.ProcessEnv), /XBRL_WAREHOUSE_URL/);
});

test("AC-5: fact rows become companyfacts rows", async () => {
  const { warehouseFactsToCompanyFacts } = await mod();
  const cf = warehouseFactsToCompanyFacts([
    fact({}),
    fact({ concept_namespace: "http://xbrl.sec.gov/dei/2025", concept_name: "EntityCommonStockSharesOutstanding",
      concept_qname: "dei:EntityCommonStockSharesOutstanding", value_decimal: "15000", unit_numerator_json: '["xbrli:shares"]',
      period_kind: "instant", period_start: null, period_end: null, period_instant: "2025-10-17" }),
    fact({ concept_name: "EarningsPerShareDiluted", concept_qname: "us-gaap:EarningsPerShareDiluted", value_decimal: "7.46",
      unit_numerator_json: '["iso4217:USD"]', unit_denominator_json: '["xbrli:shares"]' }),
    fact({ dimensions_json: '{"us-gaap:StatementBusinessSegmentsAxis":"aapl:AmericasSegmentMember"}', dimension_hash: "abc" }),
    fact({ concept_namespace: "http://www.apple.com/20250927", concept_qname: "aapl:Custom", concept_name: "Custom" }),
    fact({ is_nil: true, value_decimal: null }),
  ], { cik: "0000320193", entityName: "Apple Inc." });
  assert.equal(cf.cik, 320193);
  assert.equal(cf.entityName, "Apple Inc.");
  assert.deepEqual(Object.keys(cf.facts).sort(), ["dei", "us-gaap"]);
  const rev = cf.facts["us-gaap"].Revenues.units.USD;
  assert.equal(rev.length, 1, "dimensional and nil facts dropped");
  assert.deepEqual(rev[0], { start: "2024-09-29", end: "2025-09-27", val: 1000, accn: "0000320193-25-000079", fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31" });
  const shares = cf.facts.dei.EntityCommonStockSharesOutstanding.units.shares[0];
  assert.equal(shares.end, "2025-10-17");
  assert.equal("start" in shares, false);
  assert.equal(cf.facts["us-gaap"].EarningsPerShareDiluted.units["USD/shares"][0].val, 7.46);
});

test("AC-6: without a warehouse URL, SEC companyfacts is fetched with the User-Agent", async () => {
  const { loadCompanyFacts } = await mod();
  const { fetchImpl, calls } = stubFetch([[/data\.sec\.gov\/api\/xbrl\/companyfacts\/CIK0000320193\.json/, { cik: 320193, facts: { "us-gaap": {} } }]]);
  const out = await loadCompanyFacts({ cik: "0000320193", submissions: submissions([]), cutoffDate: "2025-12-31", userAgent: UA, env: {} as NodeJS.ProcessEnv, fetchImpl });
  assert.equal(out.origin.provider, "sec_companyfacts");
  assert.equal(out.origin.reason, undefined);
  assert.equal(calls.length, 1);
  assert.equal((calls[0].init?.headers as Record<string, string>)["User-Agent"], UA);

  const failing = stubFetch([[/companyfacts/, new Response("nope", { status: 503 })]]);
  await assert.rejects(loadCompanyFacts({ cik: "0000320193", submissions: submissions([]), cutoffDate: "2025-12-31", userAgent: UA, env: {} as NodeJS.ProcessEnv, fetchImpl: failing.fetchImpl }), /SEC companyfacts failed: 503/);
});

const subs = submissions([
  { form: "8-K", accessionNumber: "0000320193-26-000001", filingDate: "2026-01-29" },
  { form: "10-K", accessionNumber: "0000320193-25-000079", filingDate: "2025-10-31" },
  { form: "10-Q", accessionNumber: "0000320193-25-000073", filingDate: "2025-08-01" },
]);

test("AC-7: a warehouse holding the newest periodic filing supplies the facts", async () => {
  const { loadCompanyFacts } = await mod();
  const { fetchImpl, calls } = stubFetch([
    [/\/v1\/companies\/320193\/filings/, { items: [
      { accession: "0000320193-25-000079", form: "10-K", filed_date: "2025-10-31" },
      { accession: "0000320193-25-000073", form: "10-Q", filed_date: "2025-08-01" },
    ] }],
    [/\/v1\/facts\?.*accession=0000320193-25-000079/, { items: [fact({})] }],
    [/\/v1\/facts\?.*accession=0000320193-25-000073/, { items: [fact({ accession: "0000320193-25-000073", form: "10-Q", filed_date: "2025-08-01",
      fiscal_period: "Q3", period_start: "2025-03-30", period_end: "2025-06-28", value_decimal: "250" })] }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000320193", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env, fetchImpl });
  assert.equal(out.origin.provider, "xbrl_warehouse");
  assert.equal(out.origin.accessions, 2);
  assert.equal(calls.some((c) => /data\.sec\.gov/.test(c.url)), false, "no SEC companyfacts call");
  assert.equal(out.companyFacts.facts["us-gaap"].Revenues.units.USD.length, 2);
});

test("AC-8: a warehouse missing the newest periodic filing falls back to SEC", async () => {
  const { loadCompanyFacts } = await mod();
  const { fetchImpl, calls } = stubFetch([
    [/\/v1\/companies\/320193\/filings/, { items: [{ accession: "0000320193-25-000073", form: "10-Q", filed_date: "2025-08-01" }] }],
    [/data\.sec\.gov\/api\/xbrl\/companyfacts/, { cik: 320193, facts: {} }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000320193", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env, fetchImpl });
  assert.equal(out.origin.provider, "sec_companyfacts");
  assert.match(String(out.origin.reason), /^XBRL warehouse/);
  assert.match(String(out.origin.reason), /0000320193-25-000079/);
  assert.ok(calls.some((c) => /data\.sec\.gov/.test(c.url)));
});

test("AC-8: an unreachable warehouse falls back to SEC", async () => {
  const { loadCompanyFacts } = await mod();
  const { fetchImpl } = stubFetch([
    [/127\.0\.0\.1/, new TypeError("fetch failed")],
    [/data\.sec\.gov/, { cik: 320193, facts: {} }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000320193", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env, fetchImpl });
  assert.equal(out.origin.provider, "sec_companyfacts");
  assert.match(String(out.origin.reason), /^XBRL warehouse/);
});

test("AC-9: existing companyfacts readers work on adapter output", async () => {
  const { warehouseFactsToCompanyFacts } = await mod();
  const { latestSecInstantFact, dominantCurrency, reportingTaxonomy } = await import("../../../src/lib/research/history/sec-companyfacts");
  const cf = warehouseFactsToCompanyFacts([
    fact({ concept_name: "Assets", concept_qname: "us-gaap:Assets", value_decimal: "359241", period_kind: "instant",
      period_start: null, period_end: null, period_instant: "2025-09-27" }),
    fact({}),
  ], { cik: 320193, entityName: "Apple Inc." });
  assert.equal(dominantCurrency(cf), "USD");
  assert.equal(reportingTaxonomy(cf), "us-gaap");
  const assets = latestSecInstantFact(cf, "us-gaap", "Assets", "USD", new Date("2025-12-31T00:00:00Z"));
  assert.deepEqual(assets, { value: 359241, end: "2025-09-27", filed: "2025-10-31", accession_number: "0000320193-25-000079" });
});
