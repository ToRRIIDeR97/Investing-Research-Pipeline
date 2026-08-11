export interface BenchmarkCase {
  caseId: string;
  symbol: string;
  yahooSymbol: string;
  asOfDate: string;
  archetype: string;
  benchmarkSymbol: string;
  sectorBenchmarkSymbol: string;
  currency: string;
  cik?: string;
}

export interface BenchmarkPrediction {
  caseId: string;
  predictionDate: string;
  predictionPrice: number;
  horizonMonths: 12;
  returnUnit: "decimal";
  bearReturn: number;
  baseReturn: number;
  bullReturn: number;
  probabilityWeightedReturn: number;
  benchmarkSymbol?: string;
  currency?: string;
}

export interface BenchmarkOutcome {
  caseId: string;
  realizedReturn6m?: number;
  realizedReturn12m?: number;
  realizedReturn24m?: number;
  benchmarkReturn12m?: number;
  sectorBenchmarkReturn12m?: number;
  momentumReturn12m?: number;
}

export interface BenchmarkReport {
  campaignId: string;
  status: "unproven" | "measured";
  validCases: number;
  totalCases: number;
  metrics: Record<string, number | null>;
  confidenceIntervals: Record<string, [number, number]>;
  baseline: Record<string, number | null>;
  cases: Array<{
    caseId: string;
    forecastError12m: number;
    directionalHit12m: boolean;
    intervalCovered12m: boolean;
  }>;
}
