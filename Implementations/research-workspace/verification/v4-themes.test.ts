// Independent checks for P4 (T-1 to T-6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ThemeRequest, countAgreement, excludeCandidates, rankCandidates, scorecardRow, validateTickers } from "../../../src/lib/research/themes";
import { companyFacts } from "../acceptance/p4-themes.test";

test("V-T1: a hundred tickers at most; horizon bounds", () => {
  const base = { theme: "Grid", horizon_years: 10, roles: ["supplier"], min_exposure: 0, us_only: false, objectives: { growth: 1, quality: 0, value: 0, balance_sheet: 0 } };
  assert.ok(!ThemeRequest.safeParse({ ...base, tickers: Array.from({ length: 101 }, (_, i) => `T${i}`) }).success);
  assert.ok(!ThemeRequest.safeParse({ ...base, horizon_years: 2 }).success);
});

test("V-T2: empty sources and blank tickers", () => {
  assert.deepEqual(countAgreement([]), []);
  assert.deepEqual(countAgreement([{ source: "a", tickers: ["", "  "] }]), []);
});

test("V-T3: an empty SEC list knows nothing", () => {
  assert.deepEqual(validateTickers(["PWR"], {}), { valid: [], unknown: ["PWR"] });
});

test("V-T4: an exposure exactly at the threshold is kept; other roles kept when allowed", () => {
  const { kept } = excludeCandidates([{ ticker: "X", role: "supplier", exposure: 0.5, us_listed: false }, { ticker: "Y", role: "other", exposure: 0.9, us_listed: true }],
    { roles: ["supplier", "other"], min_exposure: 0.5, us_only: false });
  assert.deepEqual(kept.map((k) => k.ticker), ["X", "Y"]);
});

test("V-T5: fewer than six years gives no five-year CAGR; negative FCF gives no payback", () => {
  const facts = structuredClone(companyFacts) as any;
  facts.facts["us-gaap"].Revenues.units.USD = facts.facts["us-gaap"].Revenues.units.USD.filter((f: any) => f.fy >= 2022);
  facts.facts["us-gaap"].PaymentsToAcquirePropertyPlantAndEquipment.units.USD[0].val = 900;
  const row = scorecardRow(facts, null);
  assert.equal(row.revenue_cagr_5y, null);
  assert.equal(row.payback_years, null);
  assert.ok(row.revenue_growth_1y !== null);
});

test("V-T6: ties share a percentile; ordering ties break by ticker", () => {
  const rows = [{ ticker: "B", growth: 0.1, quality: null, value: null, balance_sheet: null }, { ticker: "A", growth: 0.1, quality: null, value: null, balance_sheet: null }];
  assert.deepEqual(rankCandidates(rows, { growth: 1, quality: 0, value: 0, balance_sheet: 0 }).map((r) => [r.ticker, r.score]), [["A", 50], ["B", 50]]);
});
