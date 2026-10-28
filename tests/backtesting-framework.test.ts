import { describe, it } from "node:test";
import assert from "node:assert";
import { deterministicBars } from "@/lib/market-data/providers/mock";
import {
  INDICATOR_CATALOG,
  MINIMUM_COMBINATION_COUNT,
  generateStrategyCombinations,
  performanceSummary,
  runFrameworkBacktest,
} from "@/lib/backtesting/framework";
import { loadFrameworkMarketDataset } from "@/lib/backtesting/framework-runner";
import type { ResearchRunContext } from "@/lib/research/run-context";

function dataset() {
  return {
    symbol: "SOFI",
    asset: deterministicBars("SOFI", 12, 900),
    benchmarks: {
      QQQ: deterministicBars("QQQ", 100, 900),
      XLF: deterministicBars("XLF", 40, 900),
      KRE: deterministicBars("KRE", 45, 900),
      SPY: deterministicBars("SPY", 300, 900),
    },
    primaryBenchmark: "QQQ",
    sectorBenchmark: "XLF",
    broadBenchmark: "SPY",
    source: "synthetic_fixture" as const,
  };
}

describe("framework-style research backtesting", () => {
  it("designs at least ten indicators and labels proxy-data limitations", () => {
    assert.ok(INDICATOR_CATALOG.length >= 10);
    assert.ok(INDICATOR_CATALOG.every((item) =>
      item.hypothesis && item.source && item.lookaheadRisk && item.expectedUse && item.failureCondition
    ));
    const cautious = INDICATOR_CATALOG.filter((item) => item.backtestability === "backtestable_with_caution");
    assert.ok(cautious.length >= 4);
    assert.ok(cautious.some((item) => item.key === "fundamental_growth_trend"));
  });

  it("generates 50 thesis-distinct combinations across five balanced buckets", () => {
    const combinations = generateStrategyCombinations("SOFI member and funding flywheel");
    assert.equal(combinations.length, MINIMUM_COMBINATION_COUNT);
    assert.equal(new Set(combinations.map((item) => item.combinationKey)).size, 50);
    assert.ok(combinations.every((item) => new Set(item.familiesUsed).size >= 2));
    const bucketCounts = new Map<string, number>();
    for (const item of combinations) {
      bucketCounts.set(item.leadBucket, (bucketCounts.get(item.leadBucket) || 0) + 1);
    }
    assert.equal(bucketCounts.size, 5);
    assert.ok([...bucketCounts.values()].every((count) => count === 10));
  });

  it("executes, ranks, and reviews all combinations with IS/OOS and benchmark evidence", () => {
    const combinations = generateStrategyCombinations("SOFI member and funding flywheel");
    const result = runFrameworkBacktest(dataset(), combinations, 10);
    assert.equal(result.rankings.length, 50);
    assert.ok(result.observations >= 260);
    assert.equal(result.transaction_cost_bps, 10);
    assert.ok(result.split_date);
    assert.ok(result.benchmark_metrics.SOFI_buy_hold);
    assert.ok(result.benchmark_metrics.SPY_benchmark);
    for (const item of result.rankings) {
      assert.ok(Number.isFinite(item.final_score));
      assert.ok(item.metrics.in_sample);
      assert.ok(item.metrics.out_of_sample);
      assert.ok(Number.isFinite(item.metrics.out_of_sample_excess_return));
      assert.equal(item.metrics.parameter_stability.family_peer_count, 9);
      if (item.status === "Robust" || item.status === "Promising") {
        assert.ok(item.metrics.number_of_trades >= 12);
        assert.ok(item.metrics.out_of_sample_return > 0);
        assert.ok(item.metrics.out_of_sample_excess_return > 0);
        assert.ok(item.metrics.benchmark_relative_return > 0);
      }
    }
  });

  it("applies each signal one bar later to prevent lookahead", () => {
    const combinations = generateStrategyCombinations("SOFI thesis");
    const result = runFrameworkBacktest(dataset(), combinations, 10);
    const definition = combinations[0];
    const executed = result.combinations.find((item) => item.combination_key === definition.combinationKey)!;
    const entry = result.indicators[definition.entryIndicator];
    const confirmation = result.indicators[definition.confirmationIndicator];
    const risk = result.indicators[definition.riskIndicator];
    const compare = (value: number | null, operator: string, threshold: number) => {
      if (value == null) return false;
      if (operator === ">=") return value >= threshold;
      if (operator === ">") return value > threshold;
      if (operator === "<=") return value <= threshold;
      return value < threshold;
    };
    for (let index = 1; index < executed.positions.length; index += 1) {
      const signalIndex = index - 1;
      const entryPass = compare(entry[signalIndex], definition.entryOperator, definition.entryThreshold);
      const confirmationPass = compare(confirmation[signalIndex], definition.confirmationOperator, definition.confirmationThreshold);
      const riskPass = compare(risk[signalIndex], definition.riskOperator, definition.riskThreshold);
      const expected = entryPass && confirmationPass && riskPass ? definition.maxPosition : 0;
      assert.equal(executed.positions[index], expected);
    }
  });
});

describe("framework metrics (#119)", () => {
  const days = (n: number) => Array.from({ length: n }, (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);

  it("computes Sortino from downside deviation over every observation", () => {
    const stream = [-0.01, -0.01, 0.02, 0.01];
    const metrics = performanceSummary(stream, [1, 1, 1, 1], days(4));
    const downside = Math.sqrt((0.01 ** 2 + 0.01 ** 2) / 4) * Math.sqrt(252);
    const expected = (stream.reduce((a, b) => a + b, 0) / 4) * 252 / downside;
    assert.ok(Math.abs(metrics.sortino - expected) < 1e-9, `${metrics.sortino} vs ${expected}`);
  });

  it("measures drawdown from the initial capital, so a first-day loss counts", () => {
    const metrics = performanceSummary([-0.1, 0.05], [1, 1], days(2));
    assert.ok(Math.abs(metrics.max_drawdown - -0.1) < 1e-12);
  });

  it("does not count a position carried in from before the slice as a trade", () => {
    assert.equal(performanceSummary([0, 0, 0], [1, 1, 0], days(3), 1).number_of_trades, 1);
    assert.equal(performanceSummary([0, 0, 0], [1, 1, 0], days(3)).number_of_trades, 2);
  });

  it("bases the Rejected label on in-sample data only", () => {
    const result = runFrameworkBacktest(dataset(), generateStrategyCombinations("SOFI thesis"), 10);
    for (const item of result.combinations) {
      const inSample = item.metrics.in_sample;
      const rejectedInSample = inSample.max_drawdown < -0.5 || inSample.number_of_trades < 2 || item.final_score < 0;
      assert.equal(item.status === "Rejected", rejectedInSample, item.combination_key);
    }
  });

  it("uses one price basis per series instead of mixing adjusted and raw closes", () => {
    const base = dataset();
    // Adjusted closes are half the raw close except on the last bar, which has none.
    const asset = base.asset.map((bar, i, all) => ({ ...bar, adjusted_close: i === all.length - 1 ? undefined : bar.close / 2 }));
    const result = runFrameworkBacktest({ ...base, asset }, generateStrategyCombinations("SOFI thesis"), 10);
    const expected = asset.at(-1)!.close / asset[0].close - 1;
    assert.ok(Math.abs(result.benchmark_metrics.SOFI_buy_hold.total_return - expected) < 1e-9);
  });
});

describe("framework market data cutoff (#101)", () => {
  it("drops the cutoff day's bar, whose close is not final yet", async () => {
    const nyOpen = (day: string) => Date.parse(`${day}T13:30:00Z`) / 1000;
    const days = ["2026-10-07", "2026-10-08", "2026-10-09"];
    const body = JSON.stringify({ chart: { error: null, result: [{
      meta: { currency: "USD", symbol: "X", exchangeName: "NMS", instrumentType: "EQUITY", firstTradeDate: 0, regularMarketTime: 0,
        gmtoffset: -14400, timezone: "EDT", exchangeTimezoneName: "America/New_York", regularMarketPrice: 3, chartPreviousClose: 1 },
      timestamp: days.map(nyOpen),
      indicators: { quote: [{ open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 1, 1] }], adjclose: [{ adjclose: [1, 2, 3] }] },
    }] } });
    const cutoff = new Date("2026-10-09T18:00:00Z");
    const ctx = { symbol: "X", marketDataCutoffAt: cutoff, cutoffAt: cutoff, testMode: false } as unknown as ResearchRunContext;
    const previous = process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
    try {
      const data = await loadFrameworkMarketDataset(ctx, { symbols: ["SPY"], primaryBenchmark: "SPY", sectorBenchmark: null, broadBenchmark: "SPY" },
        (async () => new Response(body, { status: 200 })) as typeof fetch);
      assert.deepEqual(data.asset.map((bar) => bar.trading_date.toISOString().slice(0, 10)), ["2026-10-07", "2026-10-08"]);
      assert.equal(data.benchmarks.SPY.length, 2);
    } finally {
      if (previous !== undefined) process.env.RESEARCH_ACCEPTANCE_PROVIDER = previous;
    }
  });
});
