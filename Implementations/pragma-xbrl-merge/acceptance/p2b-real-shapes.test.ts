// P2 (added in review, AC-5/AC-7/AC-8): warehouse rows as the real API returns them.
// Shapes come from the warehouse source: duplicate_ordinal counts from 1 (arelle_adapter.py:1445), dimension_hash
// is lower(hex(sha256(dimensions_json))) (040_views.sql:18), dimensions_json is "[]" without dimensions, is_nil is a
// UInt8, value_decimal is a JSON number. /v1 needs a Bearer key when XBRL_API_KEY is set (api/app.py:70-79).
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fact, stubFetch, submissions } from "./support";

const mod = () => import("../../../src/lib/research/history/xbrl-warehouse");
const UA = "Pragma Research test@example.com";
const env = { XBRL_WAREHOUSE_URL: "http://127.0.0.1:8080" } as unknown as NodeJS.ProcessEnv;
const EMPTY_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const real = (over: Record<string, unknown> = {}) => fact({
  duplicate_ordinal: 1, dimension_hash: EMPTY_HASH, dimensions_json: "[]", is_nil: 0, value_decimal: 1000, ...over,
});

test("AC-5: real rows without dimensions are kept; dimensional, nil and later duplicates are dropped", async () => {
  const { warehouseFactsToCompanyFacts } = await mod();
  const cf = warehouseFactsToCompanyFacts([
    real(),
    real({ duplicate_ordinal: 2, value_decimal: 1001 }),
    real({ concept_name: "NetIncomeLoss", concept_qname: "us-gaap:NetIncomeLoss", is_nil: 1, value_decimal: null }),
    real({ dimensions_json: '[{"dimension":"us-gaap:StatementBusinessSegmentsAxis","member":"aapl:AmericasSegmentMember"}]',
      dimension_hash: "9a".repeat(32), value_decimal: 400 }),
  ], { cik: 320193, entityName: "Apple Inc." });
  assert.deepEqual(Object.keys(cf.facts["us-gaap"]), ["Revenues"]);
  assert.deepEqual(cf.facts["us-gaap"].Revenues.units.USD.map((r: any) => r.val), [1000]);
});

const subs = submissions([
  { form: "10-K", accessionNumber: "0000320193-25-000079", filingDate: "2025-10-31" },
  { form: "10-Q", accessionNumber: "0000320193-25-000073", filingDate: "2025-08-01" },
]);
const filings = { items: [
  { accession: "0000320193-25-000079", form: "10-K", filed_date: "2025-10-31" },
  { accession: "0000320193-25-000073", form: "10-Q", filed_date: "2025-08-01" },
  { accession: "0000320193-25-000080", form: "8-K", filed_date: "2025-10-30" },
] };

test("AC-7: the Bearer key is sent, 8-Ks are not read, and a 503 page is retried smaller", async () => {
  const { loadCompanyFacts } = await mod();
  let first = true;
  const { fetchImpl, calls } = stubFetch([
    [/\/filings\?/, filings],
    [/accession=0000320193-25-000079.*limit=10000/, () => { if (first) { first = false; return new Response("cap", { status: 503 }); } return { items: [] }; }],
    [/accession=0000320193-25-000079/, { items: [real()] }],
    [/accession=0000320193-25-000073/, { items: [real({ accession: "0000320193-25-000073", form: "10-Q", period_start: "2025-03-30", period_end: "2025-06-28" })] }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000320193", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA,
    env: { ...env, XBRL_WAREHOUSE_API_KEY: "test-key" } as NodeJS.ProcessEnv, fetchImpl });
  assert.equal(out.origin.provider, "xbrl_warehouse", out.origin.reason);
  assert.equal(out.origin.accessions, 2);
  assert.ok(calls.filter((c) => /127\.0\.0\.1/.test(c.url)).every((c) => (c.init?.headers as Record<string, string>).Authorization === "Bearer test-key"));
  assert.equal(calls.some((c) => /0000320193-25-000080/.test(c.url)), false, "8-K facts not read");
  assert.ok(calls.some((c) => /accession=0000320193-25-000079.*limit=2000/.test(c.url)), "retried with a smaller page");
  assert.equal(out.companyFacts.facts["us-gaap"].Revenues.units.USD.length, 2);
});

test("AC-8: facts that rebuild to nothing fall back to SEC instead of an empty companyfacts", async () => {
  const { loadCompanyFacts } = await mod();
  const { fetchImpl } = stubFetch([
    [/\/filings\?/, filings],
    [/\/v1\/facts/, { items: [real({ dimensions_json: '[{"dimension":"x:Axis","member":"x:M"}]' })] }],
    [/data\.sec\.gov/, { cik: 320193, facts: { "us-gaap": { Revenues: {} } } }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000320193", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env, fetchImpl });
  assert.equal(out.origin.provider, "sec_companyfacts");
  assert.match(String(out.origin.reason), /no us-gaap or ifrs-full facts/);
});

test("AC-8: an older periodic filing in the window missing from the warehouse falls back", async () => {
  const { loadCompanyFacts } = await mod();
  const { fetchImpl } = stubFetch([
    [/\/filings\?/, { items: [filings.items[0]] }],
    [/\/v1\/facts/, { items: [real()] }],
    [/data\.sec\.gov/, { cik: 320193, facts: {} }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000320193", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env, fetchImpl });
  assert.equal(out.origin.provider, "sec_companyfacts");
  assert.match(String(out.origin.reason), /lacks 1 of 2 periodic filings.*0000320193-25-000073/);
});
