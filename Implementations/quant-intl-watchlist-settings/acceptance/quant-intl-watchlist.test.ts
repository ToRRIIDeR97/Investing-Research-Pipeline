// Acceptance tests for Implementations/quant-intl-watchlist-settings (frozen copy in that folder's acceptance/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProfileKeyFor } from "../../../src/lib/research/asset-profile";
import { parseYahooFundamentals } from "../../../src/lib/quant/yahoo-fundamentals";
import { benchmarkFor } from "../../../src/lib/quant/benchmarks";
import { parseYahooSearch } from "../../../src/lib/market-data/company-search";
import { readStoredFile, compressStoredFile } from "../../../src/lib/storage/stored-file";
import { referencedWithGz } from "../../../src/lib/maintenance/storage-gc";
import { rescaleDcf } from "../../../src/lib/quant/value/rescale";
import { computeDcf, type EngineResult, type PragmaData } from "../../../src/lib/quant/value/model";
import { normalizeWatchTicker } from "../../../src/lib/api/watchlist";
import { applySettingsToEnv, parseSettingsFile, sanitizeSettings, serializeSettings, publicSettings } from "../../../src/lib/settings/model-settings";

// AC-1
test("default research profile per asset kind and sector", () => {
  assert.equal(defaultProfileKeyFor("equity", null), "operating_company");
  assert.equal(defaultProfileKeyFor("equity", "Technology"), "operating_company");
  assert.equal(defaultProfileKeyFor("equity", "Financial Services"), "financials");
  assert.equal(defaultProfileKeyFor("fund", null), "etf_fund");
  assert.equal(defaultProfileKeyFor("etf", null), "etf_fund");
  assert.equal(defaultProfileKeyFor("commodity", null), "commodity_energy");
  assert.equal(defaultProfileKeyFor("crypto_asset", null, "bitcoin"), "bitcoin");
  assert.equal(defaultProfileKeyFor("crypto_asset", null, "ethereum"), null);
});

// AC-5
const series = (type: string, rows: [string, number, string?][]) => ({
  meta: { symbol: ["BBCA.JK"], type: [type] },
  [type]: rows.map(([asOfDate, raw, cur]) => ({ asOfDate, periodType: type.startsWith("quarterly") ? "3M" : "12M", currencyCode: cur ?? "IDR", reportedValue: { raw } })),
});
const YF = { timeseries: { result: [
  series("annualTotalRevenue", [["2023-12-31", 100], ["2024-12-31", 120], ["2025-12-31", 130]]),
  series("annualOperatingIncome", [["2024-12-31", 50], ["2025-12-31", 55]]),
  series("annualNetIncome", [["2024-12-31", 40], ["2025-12-31", 44]]),
  series("annualCapitalExpenditure", [["2025-12-31", -7]]),
  series("annualCashDividendsPaid", [["2025-12-31", -20]]),
  series("annualStockholdersEquity", [["2025-12-31", 300]]),
  series("annualGoodwill", [["2025-12-31", 10]]),
  series("annualDilutedAverageShares", [["2025-12-31", 1000]]),
  series("quarterlyTotalRevenue", [["2025-06-30", 30], ["2025-09-30", 33]]),
  series("quarterlyOperatingIncome", [["2025-06-30", 12], ["2025-09-30", 14]]),
  { meta: { type: ["annualEmpty"] } },
] } };

test("Yahoo fundamentals timeseries become annual fundamentals", () => {
  const f = parseYahooFundamentals(YF)!;
  assert.ok(f);
  assert.equal(f.currency, "IDR");
  assert.deepEqual(f.years.map((y) => y.period_end), ["2025-12-31", "2024-12-31", "2023-12-31"]);
  const y0 = f.years[0].values;
  assert.equal(y0.revenue, 130);
  assert.equal(y0.ebit, 55);
  assert.equal(y0.capex, 7);
  assert.equal(y0.dividends, 20);
  assert.equal(y0.tangible_book, 290);
  assert.equal(f.years[2].values.ebit, null);
  assert.equal(f.shares_outstanding?.value, 1000);
  assert.deepEqual(f.quarters.map((q) => q.period_end), ["2025-09-30", "2025-06-30"]);
  assert.ok("rnd" in f.missing);
  assert.equal(parseYahooFundamentals({ timeseries: { result: [] } }), null);
  assert.equal(parseYahooFundamentals(null), null);
});

// AC-6
test("local benchmark index per exchange suffix", () => {
  const cases: [string, string][] = [["BBCA.JK", "^JKSE"], ["VOD.L", "^FTSE"], ["7203.T", "^N225"], ["0700.HK", "^HSI"], ["SHOP.TO", "^GSPTSE"],
    ["BHP.AX", "^AXJO"], ["D05.SI", "^STI"], ["RELIANCE.NS", "^NSEI"], ["500325.BO", "^BSESN"], ["SAP.DE", "^GDAXI"], ["MC.PA", "^FCHI"],
    ["005930.KS", "^KS11"], ["AAPL", "^GSPC"], ["BRK-B", "^GSPC"]];
  for (const [ticker, symbol] of cases) assert.equal(benchmarkFor(ticker).symbol, symbol, ticker);
  assert.ok(benchmarkFor("BBCA.JK").name.length > 3);
});

// AC-8
test("international search keeps dotted equity symbols; default stays US-only", () => {
  const body = { quotes: [
    { quoteType: "ETF", symbol: "BBCA", longname: "JPMorgan BetaBuilders Canada ETF" },
    { quoteType: "EQUITY", symbol: "BBCA.JK", longname: "PT Bank Central Asia Tbk", exchDisp: "Jakarta" },
    { quoteType: "EQUITY", symbol: "AAPL", longname: "Apple Inc." },
  ] };
  assert.deepEqual(parseYahooSearch(body).map((r) => r.symbol), ["AAPL"]);
  assert.deepEqual(parseYahooSearch(body, { international: true }).map((r) => r.symbol), ["BBCA.JK", "AAPL"]);
});

// AC-10
test("stored files read raw or gzipped, and compress only after a verified round trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stored-"));
  const raw = join(dir, "a.html");
  writeFileSync(raw, "<html>hello</html>");
  assert.equal((await readStoredFile(raw)).toString("utf8"), "<html>hello</html>");
  const gz = join(dir, "b.html");
  writeFileSync(`${gz}.gz`, gzipSync(Buffer.from("zipped")));
  assert.equal((await readStoredFile(gz)).toString("utf8"), "zipped");
  await assert.rejects(readStoredFile(join(dir, "missing.html")));
  const saved = await compressStoredFile(raw);
  assert.ok(saved.after > 0);
  assert.equal(existsSync(raw), false);
  assert.equal(existsSync(`${raw}.gz`), true);
  assert.equal((await readStoredFile(raw)).toString("utf8"), "<html>hello</html>");
  assert.equal(readFileSync(`${raw}.gz`).subarray(0, 2).toString("hex"), "1f8b");
});

// AC-11
test("storage-gc counts a .gz as referenced by its plain path", () => {
  const referenced = referencedWithGz(new Set(["/s/sources/a.html"]));
  assert.ok(referenced.has("/s/sources/a.html"));
  assert.ok(referenced.has("/s/sources/a.html.gz"));
});

// AC-13
function dcfFixture(): { data: PragmaData; er: EngineResult } {
  const periods = ["2025-12-31", "2024-12-31", "2023-12-31", "2022-12-31", "2021-12-31"];
  const rev = [1300, 1200, 1100, 1000, 900], ebit = [260, 230, 210, 190, 170], ocf = [300, 270, 250, 220, 200], capex = [-50, -45, -40, -38, -35];
  const data: PragmaData = {
    info: { currentPrice: 50, sharesOutstanding: 100, marketCap: 5000, totalDebt: 200, totalCash: 100, totalRevenue: 1300, ebit: 260, operatingCashflow: 300, freeCashflow: 250 },
    income: { periods, rows: { "Total Revenue": rev, "EBIT": ebit, "Operating Income": ebit, "Net Income": ebit.map((e) => e * 0.8), "Diluted Average Shares": [100, 100, 100, 100, 100] } },
    balance: { periods, rows: { "Total Debt": [200, 200, 200, 200, 200], "Cash And Cash Equivalents": [100, 100, 100, 100, 100], "Total Stockholders Equity": [800, 750, 700, 650, 600] } },
    cashflow: { periods, rows: { "Operating Cash Flow": ocf, "Capital Expenditure": capex, "Free Cash Flow": ocf.map((o, i) => o + capex[i]) } },
    income_quarterly: { periods: [], rows: {} },
    history: Array.from({ length: 1300 }, (_, i) => ({ day: new Date(Date.UTC(2021, 0, 1) + i * 86400000 * 1.4).toISOString().slice(0, 10), close: 30 + i * 0.015 })),
  } as PragmaData;
  const er: EngineResult = {
    metric_weights: { "EV/EBIT": 0.5, "P/FCF": 0.5 }, quality_growth_adj: 0, primary_metric: "EV/EBIT", primary_value: 10, primary_industry_pct: 50,
    secondary_metric: "P/FCF", secondary_value: 20, quality_flags: [], structural_flags: [], data_quality: "High", engine_note: "Engine A — test",
    dcf_inputs: { base_cf: 260, cf_label: "EBIT", base_cagr: 0.09, net_debt: 100, shares: 100, current_price: 50, exit_metric: "EV/EBIT" },
  };
  return { data, er };
}

test("rescaleDcf reproduces the model with its own growth and responds to growth", () => {
  const { data, er } = dcfFixture();
  const dcf = computeDcf("A", data, er, "Software—Application", "Technology");
  assert.equal(dcf.dcf_skipped, false, dcf.dcf_skip_reason);
  const same = rescaleDcf(dcf, { bear: dcf.growth_rate_bear, base: dcf.growth_rate_base, bull: dcf.growth_rate_bull }, 50);
  assert.ok(Math.abs(same.intrinsic_value_base - dcf.intrinsic_value_base) <= 0.01, `${same.intrinsic_value_base} vs ${dcf.intrinsic_value_base}`);
  assert.ok(Math.abs(same.intrinsic_value_bear - dcf.intrinsic_value_bear) <= 0.01);
  assert.ok(Math.abs(same.intrinsic_value_bull - dcf.intrinsic_value_bull) <= 0.01);
  const up = rescaleDcf(dcf, { bear: dcf.growth_rate_bear, base: dcf.growth_rate_base + 0.05, bull: dcf.growth_rate_bull }, 50);
  assert.ok(up.intrinsic_value_base > dcf.intrinsic_value_base);
  assert.equal(up.growth_rate_base, Math.round((dcf.growth_rate_base + 0.05) * 1e4) / 1e4);
  assert.equal(up.price_targets.length, 5);
});

// AC-14
test("watchlist tickers are normalised and validated", () => {
  assert.equal(normalizeWatchTicker(" bbca.jk "), "BBCA.JK");
  assert.equal(normalizeWatchTicker("brk-b"), "BRK-B");
  assert.equal(normalizeWatchTicker("not a ticker"), null);
  assert.equal(normalizeWatchTicker(""), null);
  assert.equal(normalizeWatchTicker(42 as unknown as string), null);
});

// AC-16, AC-17
test("model settings accept whitelisted keys only and never echo secrets", () => {
  const clean = sanitizeSettings({ RESEARCH_MODEL_PROVIDER: "anthropic-compatible", RESEARCH_MID_MODEL: "claude-sonnet-5-5", RESEARCH_MODEL_API_KEY: "sk-abcdef123456", PATH: "x", DATABASE_URL: "y", RESEARCH_CHEAP_MODEL: "bad\nvalue" });
  assert.deepEqual(Object.keys(clean).sort(), ["RESEARCH_MID_MODEL", "RESEARCH_MODEL_API_KEY", "RESEARCH_MODEL_PROVIDER"]);
  const pub = publicSettings(clean);
  assert.equal(pub.values.RESEARCH_MID_MODEL, "claude-sonnet-5-5");
  assert.equal(pub.values.RESEARCH_MODEL_API_KEY, undefined);
  assert.deepEqual(pub.secrets.RESEARCH_MODEL_API_KEY, { set: true, last4: "3456" });
  const text = serializeSettings(clean);
  assert.deepEqual(parseSettingsFile(text), clean);
  const env: Record<string, string | undefined> = { RESEARCH_MID_MODEL: "original", RESEARCH_CHEAP_MODEL: "keep" };
  const restore = applySettingsToEnv({ RESEARCH_MID_MODEL: "override", RESEARCH_MODEL_PROVIDER: "mock" }, env);
  assert.equal(env.RESEARCH_MID_MODEL, "override");
  assert.equal(env.RESEARCH_MODEL_PROVIDER, "mock");
  applySettingsToEnv({}, env, restore);
  assert.equal(env.RESEARCH_MID_MODEL, "original");
  assert.equal(env.RESEARCH_MODEL_PROVIDER, undefined);
  assert.equal(env.RESEARCH_CHEAP_MODEL, "keep");
});
