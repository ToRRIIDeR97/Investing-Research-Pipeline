// T-1 to T-6: theme research's pure parts: request, source agreement, ticker validation, exclusions, scorecard, ranking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ThemeRequest, countAgreement, excludeCandidates, rankCandidates, scorecardRow, validateTickers } from "../../../src/lib/research/themes";

test("T-1: a theme request names a theme, roles, exposure and objectives", () => {
  const ok = { theme: "Future of the electricity grid", horizon_years: 15, roles: ["supplier"], min_exposure: 0.5, us_only: true,
    objectives: { growth: 1, quality: 0.5, value: 0.5, balance_sheet: 0.5 } };
  assert.ok(ThemeRequest.safeParse(ok).success);
  assert.ok(ThemeRequest.safeParse({ ...ok, tickers: ["PWR", "HUBB"] }).success);
  assert.ok(!ThemeRequest.safeParse({ ...ok, roles: [] }).success);
  assert.ok(!ThemeRequest.safeParse({ ...ok, objectives: { growth: 0, quality: 0, value: 0, balance_sheet: 0 } }).success);
  assert.ok(!ThemeRequest.safeParse({ ...ok, min_exposure: 1.5 }).success);
  assert.ok(!ThemeRequest.safeParse({ ...ok, theme: "x" }).success);
});

test("T-2: agreement counts each source once per ticker, most agreed first", () => {
  const agreed = countAgreement([
    { source: "model:suppliers", tickers: ["pwr", "HUBB", "MTZ", "PWR "] },
    { source: "model:pure-plays", tickers: ["PWR", "HUBB", "GEV"] },
    { source: "sec:sic-1623", tickers: ["PWR", "MTZ", "MYRG"] },
  ]);
  assert.deepEqual(agreed.slice(0, 3).map(a => [a.ticker, a.count]), [["PWR", 3], ["HUBB", 2], ["MTZ", 2]]);
  assert.deepEqual(agreed.find(a => a.ticker === "PWR")!.sources, ["model:suppliers", "model:pure-plays", "sec:sic-1623"]);
  assert.deepEqual(agreed.slice(3).map(a => a.ticker), ["GEV", "MYRG"]);
});

test("T-3: tickers are checked against SEC's list", () => {
  const sec = { 0: { ticker: "PWR", title: "QUANTA SERVICES, INC.", cik_str: 1050915 }, 1: { ticker: "HUBB", title: "HUBBELL INC", cik_str: 48898 } };
  const { valid, unknown } = validateTickers(["pwr", "HUBB", "NOPE"], sec);
  assert.deepEqual(valid, [{ ticker: "PWR", title: "QUANTA SERVICES, INC.", cik: "0001050915" }, { ticker: "HUBB", title: "HUBBELL INC", cik: "0000048898" }]);
  assert.deepEqual(unknown, ["NOPE"]);
});

test("T-4: exclusions give a reason; unknown exposure is kept", () => {
  const { kept, excluded } = excludeCandidates([
    { ticker: "PWR", role: "supplier", exposure: 0.9, us_listed: true },
    { ticker: "NEE", role: "operator", exposure: 0.8, us_listed: true },
    { ticker: "SIEGY", role: "supplier", exposure: 0.3, us_listed: true },
    { ticker: "ABB", role: "supplier", exposure: 0.6, us_listed: false },
    { ticker: "MYRG", role: "supplier", exposure: null, us_listed: true },
  ], { roles: ["supplier"], min_exposure: 0.5, us_only: true });
  assert.deepEqual(kept.map(k => k.ticker), ["PWR", "MYRG"]);
  assert.deepEqual(excluded.map(e => e.ticker), ["NEE", "SIEGY", "ABB"]);
  for (const e of excluded) assert.ok(e.reason.length > 10 && !/_/.test(e.reason), e.reason);
});

const fact = (fy: number, val: number, filed = `${fy + 1}-02-20`) => ({ start: `${fy}-01-01`, end: `${fy}-12-31`, val, fy, fp: "FY", form: "10-K", filed });
const instant = (fy: number, val: number) => ({ end: `${fy}-12-31`, val, fy, fp: "FY", form: "10-K", filed: `${fy + 1}-02-20` });
const years = [2020, 2021, 2022, 2023, 2024, 2025];
export const companyFacts = { facts: { "us-gaap": {
  Revenues: { units: { USD: [...years.map((y, i) => fact(y, 1000 * 1.1 ** i)), fact(2024, 1), { ...fact(2024, 1000 * 1.1 ** 4), filed: "2026-02-20" }].map(f => f.fy === 2024 && f.val === 1 ? { ...f, filed: "2025-01-01" } : f) } },
  OperatingIncomeLoss: { units: { USD: [fact(2025, 1000 * 1.1 ** 5 * 0.2)] } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fact(2025, 400)] } },
  PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fact(2025, 150)] } },
  LongTermDebt: { units: { USD: [instant(2025, 500)] } }, ShortTermBorrowings: { units: { USD: [instant(2025, 100)] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instant(2025, 300)] } }, MarketableSecuritiesCurrent: { units: { USD: [instant(2025, 50)] } },
  EarningsPerShareDiluted: { units: { "USD/shares": [fact(2025, 5)] } },
} } };
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-6;

test("T-5: the scorecard is computed from 10-K facts, latest filing first; missing inputs stay null", () => {
  const row = scorecardRow(companyFacts, 100);
  assert.ok(near(row.revenue, 1000 * 1.1 ** 5));
  assert.ok(near(row.revenue_growth_1y, 0.1));
  assert.ok(near(row.revenue_cagr_5y, 0.1));
  assert.ok(near(row.operating_margin, 0.2));
  assert.ok(near(row.net_debt, 250));
  assert.ok(near(row.fcf, 250));
  assert.ok(near(row.payback_years, 1));
  assert.ok(near(row.pe_ttm, 20));
  const bare = scorecardRow({ facts: { "us-gaap": { Revenues: companyFacts.facts["us-gaap"].Revenues } } }, null);
  assert.equal(bare.pe_ttm, null);
  assert.equal(bare.fcf, null);
  assert.equal(bare.operating_margin, null);
});

test("T-6: ranking weighs percentiles by the operator's objectives", () => {
  const rows = [{ ticker: "A", growth: 0.3, quality: 0.1, value: null, balance_sheet: null }, { ticker: "B", growth: 0.1, quality: 0.3, value: null, balance_sheet: null },
    { ticker: "C", growth: 0.2, quality: 0.2, value: null, balance_sheet: null }];
  assert.deepEqual(rankCandidates(rows, { growth: 1, quality: 0, value: 0, balance_sheet: 0 }).map(r => [r.ticker, r.score]), [["A", 100], ["C", 50], ["B", 0]]);
  assert.deepEqual(rankCandidates(rows, { growth: 0, quality: 1, value: 0, balance_sheet: 0 }).map(r => r.ticker), ["B", "C", "A"]);
  assert.deepEqual(rankCandidates(rows, { growth: 1, quality: 0, value: 1, balance_sheet: 0 }).map(r => [r.ticker, r.score]), [["A", 50], ["C", 25], ["B", 0]]);
  assert.deepEqual(rankCandidates([rows[0]], { growth: 1, quality: 0, value: 0, balance_sheet: 0 }).map(r => r.score), [100]);
});
