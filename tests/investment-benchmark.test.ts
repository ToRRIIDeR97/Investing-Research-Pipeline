import assert from "node:assert/strict";
import test from "node:test";
import { scoreBenchmark } from "../src/lib/investment-benchmark/scoring";

test("investment benchmark stays unproven until 36 valid cases and scores deterministic metrics", () => {
  const cases = Array.from({ length: 2 }, (_, index) => ({
    caseId: `case-${index}`, symbol: `T${index}`, yahooSymbol: `T${index}`, asOfDate: "2021-12-31",
    archetype: "operating_company_core", benchmarkSymbol: "SPY", sectorBenchmarkSymbol: "XLK", currency: "USD",
  }));
  const predictions = cases.map((item, index) => ({
    caseId: item.caseId, predictionDate: item.asOfDate, predictionPrice: 100,
    horizonMonths: 12 as const, returnUnit: "decimal" as const,
    bearReturn: -0.2, baseReturn: 0.1, bullReturn: 0.3,
    probabilityWeightedReturn: index ? 0.2 : 0.1,
  }));
  const outcomes = cases.map((item, index) => ({
    caseId: item.caseId, realizedReturn12m: index ? 0.25 : 0.05,
    benchmarkReturn12m: 0.02, sectorBenchmarkReturn12m: 0.03,
  }));
  const report = scoreBenchmark("fixture", cases, predictions, outcomes);
  assert.equal(report.status, "unproven");
  assert.equal(report.validCases, 2);
  assert.equal(report.metrics.directional_accuracy_12m, 1);
  assert.ok(Array.isArray(report.confidenceIntervals.mean_excess_return_12m));
});
