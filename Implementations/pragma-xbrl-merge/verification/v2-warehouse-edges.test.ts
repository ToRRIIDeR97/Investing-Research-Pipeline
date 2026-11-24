// V2: AC-4..AC-9 warehouse edge cases: paging, duplicates, URL rules, cutoffs and error paths.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fact, stubFetch, submissions } from "./support";

const mod = () => import("../../../src/lib/research/history/xbrl-warehouse");
const UA = "Pragma Research test@example.com";
const env = (url: string) => ({ XBRL_WAREHOUSE_URL: url }) as unknown as NodeJS.ProcessEnv;

test("AC-4: credentials, a query or a non-http scheme are refused", async () => {
  const { warehouseUrlFromEnv } = await mod();
  for (const bad of ["http://user:pw@127.0.0.1:8080", "http://127.0.0.1:8080/?x=1", "ftp://127.0.0.1", "not a url"]) {
    assert.throws(() => warehouseUrlFromEnv(env(bad)), /XBRL_WAREHOUSE_URL/, bad);
  }
  assert.equal(warehouseUrlFromEnv(env("http://localhost:8080"))?.port, "8080");
  assert.equal(warehouseUrlFromEnv(env("http://10.0.0.5:8080"))?.hostname, "10.0.0.5");
});

test("AC-5: the same fact in two filings keeps both, sorted by end then filed", async () => {
  const { warehouseFactsToCompanyFacts } = await mod();
  const cf = warehouseFactsToCompanyFacts([
    fact({ accession: "0000320193-26-000002", filed_date: "2026-10-30", form: "10-K", fiscal_year: 2026 }),
    fact({ period_start: "2023-10-01", period_end: "2024-09-28", value_decimal: "900", filed_date: "2024-11-01", accession: "0000320193-24-000123", fiscal_year: 2024 }),
    fact({}),
    fact({ duplicate_ordinal: 1, value_decimal: "1001" }),
    fact({}), // exact repeat
  ], { cik: 320193, entityName: null });
  const rows = cf.facts["us-gaap"].Revenues.units.USD;
  assert.deepEqual(rows.map((r: any) => [r.end, r.filed, r.val]), [
    ["2024-09-28", "2024-11-01", 900],
    ["2025-09-27", "2025-10-31", 1000],
    ["2025-09-27", "2026-10-30", 1000],
  ]);
});

test("AC-5: IFRS and srt facts map by namespace; non-numeric text facts are dropped", async () => {
  const { warehouseFactsToCompanyFacts } = await mod();
  const cf = warehouseFactsToCompanyFacts([
    fact({ concept_namespace: "https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full", concept_qname: "ifrs-full:Revenue", concept_name: "Revenue",
      unit_numerator_json: '["iso4217:EUR"]' }),
    fact({ concept_namespace: "http://fasb.org/srt/2025", concept_qname: "srt:ProductOrServiceAxis", concept_name: "Thing", value_decimal: "5" }),
    fact({ concept_name: "DocumentType", concept_qname: "dei:DocumentType", concept_namespace: "http://xbrl.sec.gov/dei/2025",
      value_kind: "text", value_decimal: null, value_text: "10-K", raw_value: "10-K" }),
  ], { cik: 1, entityName: "X" });
  assert.equal(cf.facts["ifrs-full"].Revenue.units.EUR[0].val, 1000);
  assert.equal(cf.facts.srt.Thing.units.USD[0].val, 5);
  assert.equal(cf.facts.dei, undefined);
});

const subs = submissions([
  { form: "10-Q", accessionNumber: "0000000001-26-000010", filingDate: "2026-02-01" }, // after cutoff
  { form: "10-K/A", accessionNumber: "0000000001-25-000009", filingDate: "2025-11-20" },
  { form: "10-K", accessionNumber: "0000000001-25-000008", filingDate: "2025-10-31" },
]);

test("AC-7: filings and facts are paged; filings after the cutoff are not read", async () => {
  const { loadCompanyFacts } = await mod();
  const filings = [
    { accession: "0000000001-26-000010", form: "10-Q", filed_date: "2026-02-01" },
    { accession: "000000000125000009", form: "10-K/A", filed_date: "2025-11-20" }, // undashed: compared without dashes
    { accession: "0000000001-25-000008", form: "10-K", filed_date: "2025-10-31" },
  ];
  const big = Array.from({ length: 10_000 }, (_, i) => fact({ accession: "0000000001-25-000008", cik: 1, concept_name: `C${i}`, concept_qname: `us-gaap:C${i}` }));
  const { fetchImpl, calls } = stubFetch([
    [/\/filings\?.*offset=0/, { items: filings }],
    [/\/filings\?/, { items: [] }],
    [/accession=0000000001-25-000008.*offset=0|offset=0.*accession=0000000001-25-000008/, { items: big }],
    [/accession=0000000001-25-000008/, { items: [fact({ accession: "0000000001-25-000008", cik: 1 })] }],
    [/accession=000000000125000009/, { items: [] }],
    [/accession=0000000001-26-000010/, { items: [fact({})] }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000000001", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env: env("http://127.0.0.1:8080"), fetchImpl });
  assert.equal(out.origin.provider, "xbrl_warehouse", out.origin.reason);
  assert.equal(out.origin.accessions, 2);
  assert.equal(calls.some((c) => /0000000001-26-000010/.test(c.url)), false, "post-cutoff filing not read");
  assert.ok(calls.filter((c) => /accession=0000000001-25-000008/.test(c.url)).length >= 2, "second facts page requested");
  assert.equal(Object.keys(out.companyFacts.facts["us-gaap"]).length, 10_001);
});

test("AC-8: an empty warehouse or a 500 falls back with a reason", async () => {
  const { loadCompanyFacts } = await mod();
  for (const answer of [{ items: [] }, new Response("boom", { status: 500 }), new Response("not json", { status: 200 })]) {
    const { fetchImpl } = stubFetch([[/127\.0\.0\.1/, answer], [/data\.sec\.gov/, { cik: 1, facts: {} }]]);
    const out = await loadCompanyFacts({ cik: "0000000001", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env: env("http://127.0.0.1:8080"), fetchImpl });
    assert.equal(out.origin.provider, "sec_companyfacts");
    assert.match(String(out.origin.reason), /^XBRL warehouse/);
  }
});

test("AC-8: a facts page failing midway falls back rather than using partial facts", async () => {
  const { loadCompanyFacts } = await mod();
  const { fetchImpl } = stubFetch([
    [/\/filings\?.*offset=0/, { items: [{ accession: "0000000001-25-000009", form: "10-K/A", filed_date: "2025-11-20" },
      { accession: "0000000001-25-000008", form: "10-K", filed_date: "2025-10-31" }] }],
    [/\/filings\?/, { items: [] }],
    [/accession=0000000001-25-000009/, { items: [fact({})] }],
    [/accession=0000000001-25-000008/, new Response("gone", { status: 502 })],
    [/data\.sec\.gov/, { cik: 1, facts: { "us-gaap": {} } }],
  ]);
  const out = await loadCompanyFacts({ cik: "0000000001", submissions: subs, cutoffDate: "2025-12-31", userAgent: UA, env: env("http://127.0.0.1:8080"), fetchImpl });
  assert.equal(out.origin.provider, "sec_companyfacts");
});

test("AC-9: quarterly observations read adapter output with the cutoff applied", async () => {
  const { warehouseFactsToCompanyFacts } = await mod();
  const { secQuarterlyObservations } = await import("../../../src/lib/research/history/sec-companyfacts");
  const q = (start: string, end: string, filed: string, val: string, accession: string) =>
    fact({ form: "10-Q", fiscal_period: "Q", period_start: start, period_end: end, filed_date: filed, value_decimal: val, accession,
      concept_name: "RevenueFromContractWithCustomerExcludingAssessedTax", concept_qname: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" });
  const cf = warehouseFactsToCompanyFacts([
    q("2025-01-01", "2025-03-31", "2025-05-01", "100", "0000000001-25-000001"),
    q("2025-04-01", "2025-06-30", "2025-08-01", "110", "0000000001-25-000002"),
    q("2025-07-01", "2025-09-30", "2026-01-15", "120", "0000000001-26-000003"), // filed after cutoff
  ], { cik: 1, entityName: "X" });
  const obs = secQuarterlyObservations(cf, new Date("2025-12-31T00:00:00Z")).filter((o) => o.metric_key === "revenue");
  assert.deepEqual(obs.map((o) => [o.period_end, o.value_numeric]), [["2025-03-31", 100], ["2025-06-30", 110]]);
});
