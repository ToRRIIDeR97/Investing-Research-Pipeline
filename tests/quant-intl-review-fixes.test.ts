// Review-panel round 1 fixes for Implementations/quant-intl-watchlist-settings (R2 deductions 2 and 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { listingUnit } from "../src/lib/quant/benchmarks";
import { rescaleDcf } from "../src/lib/quant/value/rescale";
import { computeDcf, type EngineResult, type PragmaData } from "../src/lib/quant/value/model";

test("minor-unit quotes convert to the major currency (London pence, Johannesburg cents, Tel Aviv agorot)", () => {
  assert.deepEqual(listingUnit("GBp"), { currency: "GBP", factor: 0.01 });
  assert.deepEqual(listingUnit("GBX"), { currency: "GBP", factor: 0.01 });
  assert.deepEqual(listingUnit("ZAc"), { currency: "ZAR", factor: 0.01 });
  assert.deepEqual(listingUnit("ILA"), { currency: "ILS", factor: 0.01 });
  assert.deepEqual(listingUnit("GBP"), { currency: "GBP", factor: 1 });
  assert.deepEqual(listingUnit("idr"), { currency: "IDR", factor: 1 });
  assert.equal(listingUnit(""), null);
  assert.equal(listingUnit("POUNDS"), null);
  assert.equal(listingUnit(undefined), null);
});

/** A two-metric company priced in thousands (like IDR), where rounded rates would move values by more than 0.01. */
function bigFixture(): { data: PragmaData; er: EngineResult; price: number } {
  const k = 1_000_000;
  const periods = ["2025-12-31", "2024-12-31", "2023-12-31", "2022-12-31", "2021-12-31"];
  const rev = [1300, 1180, 1090, 1010, 930].map((v) => v * k), ebit = [263, 231, 214, 189, 171].map((v) => v * k);
  const ocf = [301, 268, 252, 219, 203].map((v) => v * k), capex = [-51, -46, -41, -38, -35].map((v) => v * k);
  const shares = 123_317;
  const price = 6000;
  const data: PragmaData = {
    info: { currentPrice: price, sharesOutstanding: shares, marketCap: price * shares, totalDebt: 200 * k, totalCash: 100 * k, totalRevenue: rev[0], ebit: ebit[0], operatingCashflow: ocf[0], freeCashflow: ocf[0] + capex[0] },
    income: { periods, rows: { "Total Revenue": rev, "EBIT": ebit, "Operating Income": ebit, "Net Income": ebit.map((e) => e * 0.79), "Diluted Average Shares": Array(5).fill(shares) } },
    balance: { periods, rows: { "Total Debt": Array(5).fill(200 * k), "Cash And Cash Equivalents": Array(5).fill(100 * k), "Total Stockholders Equity": [800, 750, 700, 650, 600].map((v) => v * k) } },
    cashflow: { periods, rows: { "Operating Cash Flow": ocf, "Capital Expenditure": capex, "Free Cash Flow": ocf.map((o, i) => o + capex[i]) } },
    income_quarterly: { periods: [], rows: {} },
    history: Array.from({ length: 1300 }, (_, i) => ({ day: new Date(Date.UTC(2021, 0, 1) + i * 86400000 * 1.4).toISOString().slice(0, 10), close: 4000 + i * 1.6 })),
  } as PragmaData;
  const er: EngineResult = {
    metric_weights: { "EV/EBIT": 0.6, "P/FCF": 0.4 }, quality_growth_adj: 0.00337, primary_metric: "EV/EBIT", primary_value: 10, primary_industry_pct: 50,
    secondary_metric: "P/FCF", secondary_value: 20, quality_flags: [], structural_flags: [], data_quality: "High", engine_note: "Engine A — test",
    dcf_inputs: { base_cf: ebit[0], cf_label: "EBIT", base_cagr: 0.0871234, net_debt: 100 * k, shares, current_price: price, exit_metric: "EV/EBIT" },
  };
  return { data, er, price };
}

test("rescaleDcf at the model's growth reproduces the model exactly, even at large prices", () => {
  const { data, er, price } = bigFixture();
  const dcf = computeDcf("A", data, er, "Software—Application", "Technology", 0.93);
  assert.equal(dcf.dcf_skipped, false, dcf.dcf_skip_reason);
  assert.ok(dcf.dcf_growth_raw && dcf.dcf_discount_raw !== undefined);
  const same = rescaleDcf(dcf, { bear: dcf.growth_rate_bear, base: dcf.growth_rate_base, bull: dcf.growth_rate_bull }, price);
  assert.equal(same.intrinsic_value_bear, dcf.intrinsic_value_bear);
  assert.equal(same.intrinsic_value_base, dcf.intrinsic_value_base);
  assert.equal(same.intrinsic_value_bull, dcf.intrinsic_value_bull);
  assert.deepEqual(same.price_targets, dcf.price_targets);
  // Moving one case leaves the others exactly as the model had them.
  const moved = rescaleDcf(dcf, { bear: dcf.growth_rate_bear, base: dcf.growth_rate_base + 0.03, bull: dcf.growth_rate_bull }, price);
  assert.equal(moved.intrinsic_value_bear, dcf.intrinsic_value_bear);
  assert.ok(moved.intrinsic_value_base > dcf.intrinsic_value_base);
});
