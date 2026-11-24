// Writes deterministic PragValue fixtures (Pragma's data shape) for the parity test. Run: node make-fixtures.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "cases"), { recursive: true });

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function history(seed, start, drift, vol, days = 1300) {
  const r = rng(seed); const out = []; let p = start; const d = new Date("2020-11-02T00:00:00Z");
  while (out.length < days) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      p = p * (1 + drift + vol * (r() - 0.5) * 2);
      out.push({ day: d.toISOString().slice(0, 10), close: Math.round(p * 100) / 100 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const periods = ["2025-09-30", "2024-09-30", "2023-09-30", "2022-09-30", "2021-09-30"];
const grow = (y0, g) => periods.map((_, i) => Math.round(y0 / (1 + g) ** i));
const st = (rows) => ({ periods, rows });

function make(name, meta, statements, infoExtra, hist) {
  const price = hist[hist.length - 1].close;
  const shares = infoExtra.sharesOutstanding;
  const info = { currentPrice: price, marketCap: price * shares, ...infoExtra };
  writeFileSync(join(here, "cases", `${name}.json`), JSON.stringify({ name, meta, data: { info, ...statements, income_quarterly: { periods: [], rows: {} }, history: hist } }, null, 1));
}

// A: profitable software
{
  const rev = grow(400e9, 0.06), ebit = grow(125e9, 0.08), rd = grow(30e9, 0.08), ni = grow(100e9, 0.07), da = grow(11e9, 0.03);
  make("engine_a_software", { sector: "Technology", industry: "Software—Application", companyName: "Fixture Software" }, {
    income: st({ "Total Revenue": rev, "EBIT": ebit, "Operating Income": ebit, "Net Income": ni, "Research Development": rd, "Gross Profit": rev.map((v) => Math.round(v * 0.45)), "EBITDA": ebit.map((v, i) => v + da[i]), "Diluted Average Shares": grow(15.2e9, -0.03), "Depreciation And Amortization": da }),
    balance: st({ "Total Debt": grow(100e9, -0.02), "Cash And Cash Equivalents": grow(60e9, 0.01), "Total Stockholders Equity": grow(70e9, 0.02), "Tangible Book Value": grow(65e9, 0.02) }),
    cashflow: st({ "Operating Cash Flow": grow(118e9, 0.06), "Capital Expenditure": grow(-11e9, 0.02), "Free Cash Flow": grow(107e9, 0.06), "Depreciation And Amortization": da }),
  }, { sharesOutstanding: 15e9, totalDebt: 100e9, totalCash: 60e9, totalRevenue: 400e9, grossProfits: 180e9, ebit: 125e9, ebitda: 136e9, netIncomeToCommon: 100e9, operatingCashflow: 118e9, freeCashflow: 107e9, returnOnEquity: 1.4, bookValue: 4.6, dividendYield: 0.005 }, history(7, 120, 0.0006, 0.02));
}
// B: loss-making software
{
  const rev = grow(2e9, 0.3), ebit = grow(-200e6, -0.1);
  make("engine_b_lossmaker", { sector: "Technology", industry: "Software—Infrastructure", companyName: "Fixture Cloud" }, {
    income: st({ "Total Revenue": rev, "EBIT": ebit, "Operating Income": ebit, "Net Income": grow(-250e6, -0.1), "Gross Profit": rev.map((v) => Math.round(v * 0.72)), "Diluted Average Shares": grow(300e6, 0.03) }),
    balance: st({ "Total Debt": grow(500e6, 0), "Cash And Cash Equivalents": grow(1.5e9, 0.1), "Total Stockholders Equity": grow(1.2e9, 0.1) }),
    cashflow: st({ "Operating Cash Flow": grow(150e6, 0.5), "Capital Expenditure": grow(-60e6, 0.2), "Free Cash Flow": grow(90e6, 0.5) }),
  }, { sharesOutstanding: 300e6, totalDebt: 500e6, totalCash: 1.5e9, totalRevenue: 2e9, grossProfits: 1.44e9, ebit: -200e6, operatingCashflow: 150e6, freeCashflow: 90e6, netIncomeToCommon: -250e6 }, history(11, 40, 0.0008, 0.035));
}
// B2: pre-revenue biotech
make("engine_b2_biotech", { sector: "Healthcare", industry: "Biotechnology", companyName: "Fixture Bio" }, {
  income: st({ "Total Revenue": [5e6, 2e6, 1e6, null, null], "EBIT": grow(-180e6, 0.1), "Net Income": grow(-175e6, 0.1) }),
  balance: st({ "Total Debt": grow(50e6, 0), "Cash And Cash Equivalents": grow(600e6, -0.1) }),
  cashflow: st({ "Operating Cash Flow": grow(-160e6, 0.1) }),
}, { sharesOutstanding: 80e6, totalDebt: 50e6, totalCash: 600e6, totalRevenue: 5e6, ebit: -180e6, operatingCashflow: -160e6 }, history(13, 15, 0.0002, 0.04));
// C: regional bank
{
  const ni = grow(1.2e9, 0.05);
  make("engine_c_bank", { sector: "Financial Services", industry: "Banks—Regional", companyName: "Fixture Bancorp" }, {
    income: st({ "Total Revenue": grow(5e9, 0.05), "Net Income": ni, "Diluted Average Shares": grow(400e6, -0.01) }),
    balance: st({ "Total Stockholders Equity": grow(12e9, 0.04), "Tangible Book Value": grow(9e9, 0.04), "Total Debt": grow(8e9, 0.02), "Cash And Cash Equivalents": grow(3e9, 0.02) }),
    cashflow: st({ "Operating Cash Flow": grow(1.6e9, 0.05) }),
  }, { sharesOutstanding: 400e6, totalDebt: 8e9, totalCash: 3e9, totalRevenue: 5e9, netIncomeToCommon: 1.2e9, operatingCashflow: 1.6e9, returnOnEquity: 0.1, bookValue: 30, dividendYield: 0.035, beta: 1.1 }, history(17, 32, 0.0002, 0.018));
}
// D: diversified REIT
{
  const ni = grow(900e6, 0.04), da = grow(1.4e9, 0.04);
  make("engine_d_reit", { sector: "Real Estate", industry: "REIT—Diversified", companyName: "Fixture Realty" }, {
    income: st({ "Total Revenue": grow(4.5e9, 0.06), "Net Income": ni, "EBIT": grow(2.1e9, 0.05), "Operating Income": grow(2.1e9, 0.05), "EBITDA": grow(3.5e9, 0.05), "Diluted Average Shares": grow(850e6, 0.04), "Depreciation And Amortization": da }),
    balance: st({ "Total Debt": grow(24e9, 0.05), "Cash And Cash Equivalents": grow(400e6, 0), "Total Stockholders Equity": grow(32e9, 0.05) }),
    cashflow: st({ "Operating Cash Flow": grow(2.6e9, 0.05), "Depreciation And Amortization": da, "Free Cash Flow": grow(2.2e9, 0.05) }),
  }, { sharesOutstanding: 870e6, totalDebt: 24e9, totalCash: 400e6, totalRevenue: 4.5e9, ebitda: 3.5e9, netIncomeToCommon: 900e6, operatingCashflow: 2.6e9, dividendYield: 0.055 }, history(19, 55, 0.0001, 0.015));
}
// E: regulated electric utility
{
  const ebit = grow(5e9, 0.04);
  make("engine_e_utility", { sector: "Utilities", industry: "Utilities—Regulated Electric", companyName: "Fixture Power" }, {
    income: st({ "Total Revenue": grow(16e9, 0.04), "EBIT": ebit, "Operating Income": ebit, "EBITDA": grow(8.5e9, 0.04), "Net Income": grow(3e9, 0.04), "Interest Expense": grow(1.6e9, 0.05), "Diluted Average Shares": grow(780e6, 0.01) }),
    balance: st({ "Total Debt": grow(50e9, 0.05), "Cash And Cash Equivalents": grow(500e6, 0), "Total Stockholders Equity": grow(40e9, 0.04) }),
    cashflow: st({ "Operating Cash Flow": grow(6.5e9, 0.04), "Capital Expenditure": grow(-9e9, 0.06), "Free Cash Flow": grow(-2.5e9, 0.1) }),
  }, { sharesOutstanding: 780e6, totalDebt: 50e9, totalCash: 500e6, totalRevenue: 16e9, ebitda: 8.5e9, ebit: 5e9, netIncomeToCommon: 3e9, operatingCashflow: 6.5e9, dividendYield: 0.04, effectiveTaxRate: 0.18 }, history(23, 70, 0.0002, 0.012));
}
// F: oil and gas E&P
{
  const ebit = [9e9, 14e9, 6e9, 2e9, 7e9];
  make("engine_f_energy", { sector: "Energy", industry: "Oil & Gas E&P", companyName: "Fixture Petroleum" }, {
    income: st({ "Total Revenue": [30e9, 38e9, 24e9, 15e9, 26e9], "EBIT": ebit, "Operating Income": ebit, "EBITDA": ebit.map((v) => v + 4e9), "Net Income": ebit.map((v) => Math.round(v * 0.72)), "Diluted Average Shares": grow(1.2e9, -0.02) }),
    balance: st({ "Total Debt": grow(15e9, -0.03), "Cash And Cash Equivalents": grow(5e9, 0.05), "Total Stockholders Equity": grow(45e9, 0.03) }),
    cashflow: st({ "Operating Cash Flow": [12e9, 17e9, 9e9, 5e9, 10e9], "Capital Expenditure": grow(-6e9, 0.02), "Free Cash Flow": [6e9, 11e9, 3e9, -1e9, 4e9] }),
  }, { sharesOutstanding: 1.2e9, totalDebt: 15e9, totalCash: 5e9, totalRevenue: 30e9, ebit: 9e9, ebitda: 13e9, netIncomeToCommon: 6.5e9, operatingCashflow: 12e9, freeCashflow: 6e9 }, history(29, 60, 0.0002, 0.025));
}
// G: asset manager
{
  const ni = grow(2.5e9, 0.06);
  make("engine_g_assetmgr", { sector: "Financial Services", industry: "Asset Management", companyName: "Fixture Capital" }, {
    income: st({ "Total Revenue": grow(9e9, 0.06), "Net Income": ni, "Operating Income": grow(3.4e9, 0.06), "EBIT": grow(3.4e9, 0.06), "Diluted Average Shares": grow(500e6, 0) }),
    balance: st({ "Total Debt": grow(6e9, 0), "Cash And Cash Equivalents": grow(4e9, 0.03), "Total Stockholders Equity": grow(20e9, 0.05), "Tangible Book Value": grow(8e9, 0.05) }),
    cashflow: st({ "Operating Cash Flow": grow(3e9, 0.06), "Depreciation And Amortization": grow(300e6, 0.03), "Free Cash Flow": grow(2.8e9, 0.06) }),
  }, { sharesOutstanding: 500e6, totalDebt: 6e9, totalCash: 4e9, totalRevenue: 9e9, netIncomeToCommon: 2.5e9, operatingCashflow: 3e9, freeCashflow: 2.8e9 }, history(31, 80, 0.0004, 0.02));
}
console.log("fixtures written");
