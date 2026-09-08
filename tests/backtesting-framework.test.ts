import { describe, it } from "node:test";
import assert from "node:assert";
import { deterministicBars } from "@/lib/market-data/providers/mock";
import {
  INDICATOR_CATALOG,
  MINIMUM_COMBINATION_COUNT,
  generateStrategyCombinations,
  runFrameworkBacktest,
} from "@/lib/backtesting/framework";

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
    assert.equal(new Set(combinations.map((item) => item.hypothesis)).size, 50);
    assert.ok(combinations.every((item) => item.hypothesis.startsWith("If SOFI member and funding flywheel is investable")));
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
