import assert from "node:assert/strict";
import { test } from "node:test";
import { deterministicBars } from "@/lib/market-data/providers/mock";
import {
  InsufficientBacktestHistory, SECTOR_INDICATOR_KEYS, generateStrategyCombinations, indicatorCatalog, runFrameworkBacktest,
} from "@/lib/backtesting/framework";
import { frameworkBenchmarks, loadFrameworkMarketDataset } from "@/lib/backtesting/framework-runner";
import { backtestExecutionHandler } from "@/lib/research/handlers/backtest-execution";

const dataset = (sectorBenchmark: string | null, count = 900) => ({
  symbol: "META",
  asset: deterministicBars("META", 120, count),
  benchmarks: Object.fromEntries(["QQQ", ...(sectorBenchmark ? [sectorBenchmark] : []), "SPY"]
    .map((symbol, i) => [symbol, deterministicBars(symbol, 100 + i * 50, count)])),
  primaryBenchmark: "QQQ",
  sectorBenchmark,
  broadBenchmark: "SPY",
  source: "synthetic_fixture" as const,
});

test("benchmarks follow the asset's sector; KRE only for banks; an unknown sector has none", () => {
  assert.deepEqual(frameworkBenchmarks("Communication Services"),
    { symbols: ["QQQ", "XLC", "SPY"], primaryBenchmark: "QQQ", sectorBenchmark: "XLC", broadBenchmark: "SPY" });
  assert.equal(frameworkBenchmarks("Information Technology").sectorBenchmark, "XLK");
  assert.equal(frameworkBenchmarks("Consumer Discretionary").sectorBenchmark, "XLY");
  assert.deepEqual(frameworkBenchmarks("Financial Services", true).symbols, ["QQQ", "XLF", "KRE", "SPY"]);
  assert.equal(frameworkBenchmarks("Financial Services").symbols.includes("KRE"), false);
  assert.deepEqual(frameworkBenchmarks(null), { symbols: ["QQQ", "SPY"], primaryBenchmark: "QQQ", sectorBenchmark: null, broadBenchmark: "SPY" });
});

test("without a sector benchmark the sector-derived indicators are null and catalogued not usable", () => {
  const result = runFrameworkBacktest(dataset(null), generateStrategyCombinations("META"), 10);
  for (const key of SECTOR_INDICATOR_KEYS) assert.ok(result.indicators[key].every((value) => value === null), key);
  assert.ok(result.indicators.macro_industry_signal.some((value) => value !== null));
  const catalog = indicatorCatalog(null);
  assert.deepEqual(catalog.filter((item) => item.backtestability === "not_usable").map((item) => item.key), SECTOR_INDICATOR_KEYS);
  assert.equal(indicatorCatalog("XLC").some((item) => item.backtestability === "not_usable"), false);
});

test("short aligned history raises InsufficientBacktestHistory, and a withheld execution validates", async () => {
  assert.throws(() => runFrameworkBacktest(dataset("XLK", 200), generateStrategyCombinations("META"), 10), InsufficientBacktestHistory);
  const validation = await backtestExecutionHandler.validate!({} as any, { withheld: "Backtest withheld: too short." });
  assert.equal(validation.valid, true);
});

test("each benchmark series is retried once before the stage gives up", async () => {
  const realFetch = globalThis.fetch, provider = process.env.RESEARCH_ACCEPTANCE_PROVIDER;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const symbol = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!);
    calls.push(symbol);
    if (symbol === "XLC" && calls.filter((item) => item === "XLC").length === 1) throw new Error("HTTP 429");
    const timestamps = [1767225600, 1767312000, 1767398400];
    return new Response(JSON.stringify({ chart: { error: null, result: [{
      meta: { currency: "USD", symbol, exchangeTimezoneName: "America/New_York" }, timestamp: timestamps,
      indicators: { quote: [{ open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 1, 1] }], adjclose: [{ adjclose: [1, 2, 3] }] },
    }] } }));
  }) as typeof fetch;
  delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
  try {
    const loaded = await loadFrameworkMarketDataset({ symbol: "META", testMode: false, cutoffAt: new Date("2026-01-05"), marketDataCutoffAt: null } as any,
      frameworkBenchmarks("Communication Services"));
    assert.equal(loaded.benchmarks.XLC.length, 3);
    assert.equal(calls.filter((item) => item === "XLC").length, 2);
  } finally {
    globalThis.fetch = realFetch;
    if (provider === undefined) delete process.env.RESEARCH_ACCEPTANCE_PROVIDER; else process.env.RESEARCH_ACCEPTANCE_PROVIDER = provider;
  }
});

test("the leader is chosen on in-sample metrics: changing the out-of-sample prices does not change scores or ranks", () => {
  const combinations = generateStrategyCombinations("META");
  const base = dataset("XLC");
  const before = runFrameworkBacktest(base, combinations, 10);
  const split = Date.parse(before.split_date);
  const shocked = { ...base, asset: base.asset.map((bar, i) => bar.trading_date.getTime() > split
    ? { ...bar, close: bar.close * (1 + 0.3 * Math.sin(i)), adjusted_close: (bar.adjusted_close ?? bar.close) * (1 + 0.3 * Math.sin(i)) } : bar) };
  const after = runFrameworkBacktest(shocked, combinations, 10);
  assert.notDeepEqual(after.rankings.map((item) => item.metrics.out_of_sample_return), before.rankings.map((item) => item.metrics.out_of_sample_return));
  assert.deepEqual(after.rankings.map((item) => [item.combination_key, item.final_score]), before.rankings.map((item) => [item.combination_key, item.final_score]));
  assert.match(after.rankings[0].metrics.selection_rule, /in-sample metrics only/);
});
