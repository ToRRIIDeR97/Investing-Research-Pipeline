// P1: AC-1..AC-3 fundamentals from companyfacts, volume on stored bars, SIC to Pragma sector and industry.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";

const yearBefore = (end: string) => new Date(Date.parse(`${end}T00:00:00Z`) - 363 * 86_400_000).toISOString().slice(0, 10);
const fy = (end: string, val: number, accn: string, start?: string) => ({
  start: start ?? yearBefore(end),
  end, val, accn, fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", filed: `${end.slice(0, 4)}-11-01`,
});
const inst = (end: string, val: number, accn: string) => ({ end, val, accn, fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", filed: `${end.slice(0, 4)}-11-01` });
const years = ["2021-09-25", "2022-09-24", "2023-09-30", "2024-09-28", "2025-09-27"];
const usd = (rows: unknown[]) => ({ units: { USD: rows } });
const companyFacts = {
  cik: 320193, entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      Revenues: usd(years.map((e, i) => fy(e, 100 + i * 10, `a${i}`))),
      OperatingIncomeLoss: usd(years.map((e, i) => fy(e, 30 + i, `a${i}`))),
      DepreciationDepletionAndAmortization: usd(years.map((e, i) => fy(e, 10, `a${i}`))),
      PaymentsToAcquirePropertyPlantAndEquipment: usd(years.map((e, i) => fy(e, 8, `a${i}`))),
      NetCashProvidedByUsedInOperatingActivities: usd(years.map((e, i) => fy(e, 40, `a${i}`))),
      NetIncomeLoss: usd(years.map((e, i) => fy(e, 25, `a${i}`))),
      CashAndCashEquivalentsAtCarryingValue: usd(years.map((e, i) => inst(e, 50, `a${i}`))),
      LongTermDebt: usd(years.map((e, i) => inst(e, 90, `a${i}`))),
      StockholdersEquity: usd(years.map((e, i) => inst(e, 60, `a${i}`))),
      Goodwill: usd(years.map((e, i) => inst(e, 5, `a${i}`))),
      // A quarterly fact must not be read as a year.
      ResearchAndDevelopmentExpense: usd([{ start: "2025-06-29", end: "2025-09-27", val: 7, accn: "q", fy: 2025, fp: "Q4", form: "10-Q", filed: "2025-10-30" }]),
    },
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [inst("2025-10-17", 15000, "a4")] } } },
  },
};

test("AC-1: five fiscal years, newest first, with the concept used for each field", async () => {
  const { annualFundamentals } = await import("../../../src/lib/quant/fundamentals");
  const f = annualFundamentals(companyFacts, { years: 5 });
  assert.deepEqual(f.years.map((y) => y.period_end), [...years].reverse());
  const y0 = f.years[0];
  assert.equal(y0.values.revenue, 140);
  assert.equal(y0.values.ebit, 34);
  assert.equal(y0.values.da, 10);
  assert.equal(y0.values.capex, 8);
  assert.equal(y0.values.cash, 50);
  assert.equal(y0.values.debt, 90);
  assert.equal(y0.values.tangible_book, 55);
  assert.equal(y0.concepts.revenue, "us-gaap:Revenues");
  assert.equal(f.shares_outstanding?.value, 15000);
  assert.equal(f.currency, "USD");
});

test("AC-1: a missing concept is null with a reason, never 0", async () => {
  const { annualFundamentals } = await import("../../../src/lib/quant/fundamentals");
  const f = annualFundamentals(companyFacts, { years: 5 });
  assert.equal(f.years[0].values.rnd, null, "quarterly R&D is not an annual value");
  assert.match(String(f.missing.rnd), /ResearchAndDevelopmentExpense/);
  assert.equal(f.years[0].values.interest_expense, null);
});

test("AC-2: stored bar rows map volume, null when absent", async () => {
  const { storedBarFromRow } = await import("../../../src/lib/market-data/price-history");
  const base = { id: "1", trading_date: "2025-11-20T00:00:00Z", close: "228.1", adjusted_close: null, currency: "USD", provider_symbol: "AAPL",
    retrieved_at: "2025-11-21T00:00:00Z", available_at: "2025-11-21T00:00:00Z", verification_status: "verified", verification_json: {} };
  assert.equal(storedBarFromRow({ ...base, volume: "51234000" }).volume, 51234000);
  assert.equal(storedBarFromRow({ ...base, volume: null }).volume, null);
});

test("AC-3: SIC codes map to Pragma's sector and industry names", async () => {
  const { sectorFromSic } = await import("../../../src/lib/quant/sic");
  assert.deepEqual(sectorFromSic("6022"), { sector: "Financial Services", industry: "Banks—Regional", etf: "XLF" });
  assert.deepEqual(sectorFromSic("6798"), { sector: "Real Estate", industry: "REIT—Diversified", etf: "XLRE" });
  assert.deepEqual(sectorFromSic("4911"), { sector: "Utilities", industry: "Utilities—Regulated Electric", etf: "XLU" });
  assert.deepEqual(sectorFromSic("1311"), { sector: "Energy", industry: "Oil & Gas E&P", etf: "XLE" });
  assert.deepEqual(sectorFromSic("2836"), { sector: "Healthcare", industry: "Biotechnology", etf: "XLV" });
  assert.deepEqual(sectorFromSic("7372"), { sector: "Technology", industry: "Software—Application", etf: "XLK" });
  assert.deepEqual(sectorFromSic("3571"), { sector: "Technology", industry: "Computer Hardware", etf: "XLK" });
  assert.equal(sectorFromSic("9999").sector, "Unknown");
  assert.equal(sectorFromSic(null).sector, "Unknown");
});
