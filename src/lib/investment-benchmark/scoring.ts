import type { BenchmarkCase, BenchmarkOutcome, BenchmarkPrediction, BenchmarkReport } from "./types";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values: number[], q: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function rankCorrelation(x: number[], y: number[]) {
  if (x.length < 2 || x.length !== y.length) return null;
  const rank = (values: number[]) => {
    const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const result = Array<number>(values.length);
    sorted.forEach((item, index) => { result[item.index] = index + 1; });
    return result;
  };
  const xr = rank(x);
  const yr = rank(y);
  const xm = mean(xr) || 0;
  const ym = mean(yr) || 0;
  const numerator = xr.reduce((sum, value, i) => sum + (value - xm) * (yr[i] - ym), 0);
  const denominator = Math.sqrt(
    xr.reduce((sum, value) => sum + (value - xm) ** 2, 0) *
    yr.reduce((sum, value) => sum + (value - ym) ** 2, 0)
  );
  return denominator ? numerator / denominator : 0;
}

function horizonMetrics(
  predictions: BenchmarkPrediction[],
  outcomes: BenchmarkOutcome[],
  key: "realizedReturn6m" | "realizedReturn12m" | "realizedReturn24m"
) {
  const outcomeByCase = new Map(outcomes.map((outcome) => [outcome.caseId, outcome]));
  const rows = predictions.flatMap((prediction) => {
    const realized = outcomeByCase.get(prediction.caseId)?.[key];
    return finite(realized) ? [{ predicted: prediction.probabilityWeightedReturn, realized }] : [];
  });
  return {
    meanAbsoluteError: mean(rows.map((row) => Math.abs(row.predicted - row.realized))),
    directionalAccuracy: mean(rows.map((row) => Math.sign(row.predicted) === Math.sign(row.realized) ? 1 : 0)),
    meanRealizedReturn: mean(rows.map((row) => row.realized)),
  };
}

function bootstrap(values: number[], statistic: (sample: number[]) => number | null, seed = 17): [number, number] {
  if (!values.length) return [0, 0];
  let state = seed >>> 0;
  const samples: number[] = [];
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const sample = Array.from({ length: values.length }, () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return values[state % values.length];
    });
    const result = statistic(sample);
    if (finite(result)) samples.push(result);
  }
  return [quantile(samples, 0.025) || 0, quantile(samples, 0.975) || 0];
}

export function scoreBenchmark(
  campaignId: string,
  cases: BenchmarkCase[],
  predictions: BenchmarkPrediction[],
  outcomes: BenchmarkOutcome[]
): BenchmarkReport {
  const predictionByCase = new Map(predictions.map((prediction) => [prediction.caseId, prediction]));
  const outcomeByCase = new Map(outcomes.map((outcome) => [outcome.caseId, outcome]));
  const scored = cases.flatMap((benchmarkCase) => {
    const prediction = predictionByCase.get(benchmarkCase.caseId);
    const outcome = outcomeByCase.get(benchmarkCase.caseId);
    if (!prediction || !outcome || prediction.horizonMonths !== 12 || prediction.returnUnit !== "decimal" ||
      !prediction.predictionDate || !finite(prediction.predictionPrice) || prediction.predictionPrice <= 0 ||
      !finite(prediction.bearReturn) || !finite(prediction.baseReturn) || !finite(prediction.bullReturn) ||
      !finite(prediction.probabilityWeightedReturn) || !finite(outcome.realizedReturn12m)) return [];
    const forecastError12m = prediction.probabilityWeightedReturn - outcome.realizedReturn12m;
    return [{
      caseId: benchmarkCase.caseId,
      forecastError12m,
      directionalHit12m: Math.sign(prediction.probabilityWeightedReturn) === Math.sign(outcome.realizedReturn12m),
      intervalCovered12m: outcome.realizedReturn12m >= Math.min(prediction.bearReturn, prediction.bullReturn)
        && outcome.realizedReturn12m <= Math.max(prediction.bearReturn, prediction.bullReturn),
      predicted: prediction.probabilityWeightedReturn,
      realized: outcome.realizedReturn12m,
      excess: finite(outcome.benchmarkReturn12m) ? outcome.realizedReturn12m - outcome.benchmarkReturn12m : null,
    }];
  });
  const errors = scored.map((item) => Math.abs(item.forecastError12m));
  const predicted = scored.map((item) => item.predicted);
  const realized = scored.map((item) => item.realized);
  const excess = scored.flatMap((item) => finite(item.excess) ? [item.excess] : []);
  const sectorExcess = scored.flatMap((item) => {
    const outcome = outcomeByCase.get(item.caseId);
    const value = outcome?.sectorBenchmarkReturn12m;
    return finite(value) ? [item.realized - value] : [];
  });
  const momentumExcess = scored.flatMap((item) => {
    const outcome = outcomeByCase.get(item.caseId);
    const value = outcome?.momentumReturn12m;
    return finite(value) ? [item.realized - value] : [];
  });
  const sixMonth = horizonMetrics(predictions, outcomes, "realizedReturn6m");
  const twentyFourMonth = horizonMetrics(predictions, outcomes, "realizedReturn24m");
  const quartileSize = Math.max(1, Math.floor(scored.length / 4));
  const ranked = [...scored].sort((a, b) => b.predicted - a.predicted);
  const top = mean(ranked.slice(0, quartileSize).map((item) => item.excess).filter(finite));
  const bottom = mean(ranked.slice(-quartileSize).map((item) => item.excess).filter(finite));
  const spread = top !== null && bottom !== null ? top - bottom : null;
  return {
    campaignId,
    status: scored.length >= 36 ? "measured" : "unproven",
    validCases: scored.length,
    totalCases: cases.length,
    metrics: {
      mean_absolute_error_12m: mean(errors),
      directional_accuracy_12m: mean(scored.map((item) => item.directionalHit12m ? 1 : 0)),
      interval_coverage_12m: mean(scored.map((item) => item.intervalCovered12m ? 1 : 0)),
      spearman_rank_correlation_12m: rankCorrelation(predicted, realized),
      mean_excess_return_12m: mean(excess),
      mean_sector_excess_return_12m: mean(sectorExcess),
      mean_absolute_error_6m: sixMonth.meanAbsoluteError,
      directional_accuracy_6m: sixMonth.directionalAccuracy,
      mean_realized_return_6m: sixMonth.meanRealizedReturn,
      mean_absolute_error_24m: twentyFourMonth.meanAbsoluteError,
      directional_accuracy_24m: twentyFourMonth.directionalAccuracy,
      mean_realized_return_24m: twentyFourMonth.meanRealizedReturn,
      top_quartile_excess_return_12m: top,
      bottom_quartile_excess_return_12m: bottom,
      top_bottom_quartile_spread_12m: spread,
    },
    confidenceIntervals: {
      mean_excess_return_12m: bootstrap(excess, mean),
      top_bottom_quartile_spread_12m: bootstrap(excess, (sample) => {
        const size = Math.max(1, Math.floor(sample.length / 4));
        return (mean(sample.slice(0, size)) || 0) - (mean(sample.slice(-size)) || 0);
      }),
    },
    baseline: {
      zero_excess_return: 0,
      passive_benchmark_excess_return: mean(excess),
      trailing_12m_momentum_excess_return: mean(momentumExcess),
    },
    cases: scored.map(({ caseId, forecastError12m, directionalHit12m, intervalCovered12m }) => ({
      caseId, forecastError12m, directionalHit12m, intervalCovered12m,
    })),
  };
}
