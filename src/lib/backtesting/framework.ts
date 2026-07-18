import type { PriceBar } from "@/lib/market-data/provider";

export const MINIMUM_INDICATOR_COUNT = 10;
export const MINIMUM_COMBINATION_COUNT = 50;
export const DEFAULT_TRANSACTION_COST_BPS = 10;
export const DEFAULT_SPLIT_RATIO = 0.7;

export type BacktestClassification =
  | "backtest_ready"
  | "backtestable_with_caution"
  | "qualitative_only"
  | "not_usable";

export interface IndicatorDefinition {
  key: string;
  name: string;
  family: string;
  hypothesis: string;
  calculation: string;
  source: string;
  updateFrequency: string;
  backtestability: BacktestClassification;
  lookaheadRisk: string;
  expectedUse: string;
  failureCondition: string;
}

export interface StrategyCombination {
  combinationKey: string;
  name: string;
  leadBucket: string;
  indicatorsUsed: string[];
  familiesUsed: string[];
  thesisDriver: string;
  hypothesis: string;
  entryRule: string;
  exitRule: string;
  riskControl: string;
  positionSizing: string;
  regimeAssumption: string;
  whyEconomic: string;
  whyNotCurveFit: string;
  entryIndicator: string;
  entryOperator: ComparisonOperator;
  entryThreshold: number;
  confirmationIndicator: string;
  confirmationOperator: ComparisonOperator;
  confirmationThreshold: number;
  riskIndicator: string;
  riskOperator: ComparisonOperator;
  riskThreshold: number;
  maxPosition: number;
}

export type ComparisonOperator = ">=" | ">" | "<=" | "<";

export interface MarketDataset {
  symbol: string;
  asset: PriceBar[];
  benchmarks: Record<string, PriceBar[]>;
  primaryBenchmark: string;
  sectorBenchmark: string;
  broadBenchmark: string;
  source: "yahoo" | "synthetic_fixture";
}

export interface PerformanceMetrics {
  cagr: number;
  total_return: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  max_drawdown: number;
  calmar: number;
  exposure_time: number;
  number_of_trades: number;
  win_rate: number;
  average_win: number;
  average_loss: number;
  profit_factor: number;
  turnover: number;
  best_year: number;
  worst_year: number;
}

export interface CombinationResult {
  combination_key: string;
  strategy_name: string;
  lead_bucket: string;
  indicators_used: string[];
  families_used: string[];
  status: "Robust" | "Promising" | "Needs review" | "Weak" | "Rejected";
  final_score: number;
  metrics: PerformanceMetrics & {
    benchmark_relative_return: number;
    out_of_sample_return: number;
    out_of_sample_excess_return: number;
    in_sample: PerformanceMetrics;
    out_of_sample: PerformanceMetrics;
    parameter_stability: {
      family_peer_count: number;
      family_peer_mean_oos_return: number;
      positive_family_peer_fraction: number;
    };
    split_date: string;
    transaction_cost_bps: number;
    selection_rule: string;
  };
  equity: number[];
  drawdown: number[];
  positions: number[];
}

export interface FrameworkBacktestResult {
  observations: number;
  dates: string[];
  split_date: string;
  split_ratio: number;
  transaction_cost_bps: number;
  indicators: Record<string, Array<number | null>>;
  combinations: CombinationResult[];
  rankings: CombinationResult[];
  benchmark_metrics: Record<string, PerformanceMetrics>;
  source_alignment: Array<{
    dataset: string;
    source: string;
    release_or_observation_date_used: boolean;
    classification: BacktestClassification;
    lookahead_risk: string;
    notes: string;
  }>;
}

export const INDICATOR_CATALOG: IndicatorDefinition[] = [
  indicator("asset_return_63d", "63-day asset return", "Momentum confirmation indicators", "Positive medium-term sponsorship should confirm the research thesis.", "adjusted close / adjusted close 63 sessions ago - 1"),
  indicator("asset_return_126d", "126-day asset return", "Momentum confirmation indicators", "A durable thesis should survive a longer confirmation window.", "adjusted close / adjusted close 126 sessions ago - 1"),
  indicator("drawdown_from_52w_high", "Drawdown from 52-week high", "Drawdown/recovery indicators", "Deep unresolved drawdowns can indicate impairment rather than opportunity.", "adjusted close / rolling 252-session high - 1"),
  indicator("drawdown_from_ath", "Drawdown from all-time high", "Drawdown/recovery indicators", "Structural impairment risk rises when recovery from the historical peak fails.", "adjusted close / cumulative high - 1"),
  indicator("volatility_percentile_252d", "Realized-volatility percentile", "Volatility/risk indicators", "High-volatility regimes require lower exposure.", "63-session volatility percentile within trailing 252 sessions"),
  indicator("volatility_compression", "Volatility compression", "Volatility/risk indicators", "Falling short-term volatility can identify a stabilizing regime.", "1 - 21-session volatility / 126-session volatility"),
  indicator("relative_strength_vs_primary_benchmark", "Relative strength versus primary benchmark", "Relative strength indicators", "Thesis confirmation should appear as improving relative performance.", "63-session asset return minus primary benchmark return"),
  indicator("sector_relative_strength", "Sector relative strength", "Sector rotation indicators", "Company performance is more credible when its sector is not deteriorating.", "63-session sector return minus broad-market return"),
  indicator("benchmark_trend_200d", "Broad-market 200-day trend", "Macro/liquidity indicators", "Risk assets face a harder regime below the broad-market long-term trend.", "broad benchmark / 200-session moving average - 1"),
  indicator("market_liquidity_regime", "Market liquidity regime", "Macro/liquidity indicators", "Positive broad and growth-market trends support risk-taking.", "mean of broad and primary benchmark 63-session returns"),
  cautiousIndicator("macro_industry_signal", "Macro and industry signal", "Macro/liquidity indicators", "The thesis should perform better when broad liquidity and sector leadership agree.", "mean of broad trend, primary return, and sector relative strength", "Yahoo benchmark prices are market proxies, not a full macro release-date dataset."),
  cautiousIndicator("valuation_percentile", "Price-based valuation-compression proxy", "Valuation indicators", "Large price compression can identify valuation reset opportunities for later fundamental confirmation.", "rolling percentile of price/200-session moving average", "This is a price proxy and must not be described as a filing-derived valuation history."),
  cautiousIndicator("balance_sheet_or_profitability_quality", "Quality confirmation proxy", "Quality/profitability indicators", "Stable trends and lower downside volatility proxy for market-implied quality pending point-in-time fundamentals.", "126-session return minus realized downside volatility", "This is not historical profitability or balance-sheet data."),
  cautiousIndicator("fundamental_growth_trend", "Fundamental-trend proxy", "Fundamental trend indicators", "Sustained price sponsorship is only a temporary proxy until release-date fundamental history is aligned.", "blend of 63- and 126-session returns", "Replace with filing-derived, release-date-aligned growth observations."),
  cautiousIndicator("commodity_or_input_trend", "Input-cost regime proxy", "Commodity sensitivity indicators", "Sector and broad-market dispersion can proxy for input/regime pressure.", "sector 63-session return minus primary benchmark return", "Replace with an asset-specific commodity or input-price series where relevant."),
  cautiousIndicator("asset_specific_external_signal", "Asset-specific external proxy", "Asset-specific external source indicators", "Volume-confirmed relative strength can proxy for external sponsorship.", "signed 63-session volume balance plus relative strength", "Replace with a real asset-specific point-in-time external dataset."),
];

function indicator(
  key: string,
  name: string,
  family: string,
  hypothesis: string,
  calculation: string
): IndicatorDefinition {
  return {
    key,
    name,
    family,
    hypothesis,
    calculation,
    source: "Yahoo Finance adjusted daily price and volume history",
    updateFrequency: "daily",
    backtestability: "backtest_ready",
    lookaheadRisk: "Signal is calculated through date t and applied to return t+1.",
    expectedUse: "Entry, confirmation, or risk-control input in a named strategy combination.",
    failureCondition: "Fails if the series is unavailable, stale, or lacks the required lookback.",
  };
}

function cautiousIndicator(
  key: string,
  name: string,
  family: string,
  hypothesis: string,
  calculation: string,
  limitation: string
): IndicatorDefinition {
  return {
    ...indicator(key, name, family, hypothesis, calculation),
    backtestability: "backtestable_with_caution",
    lookaheadRisk: `Signal is shifted one session. ${limitation}`,
    failureCondition: `Do not interpret as direct fundamental evidence. ${limitation}`,
  };
}

const BLUEPRINTS = [
  ["price-yfinance-only", "Momentum confirmation indicators", "asset_return_63d", ">=", 0, "price and Yahoo trend confirmation"],
  ["price-macro-industry", "Macro/liquidity indicators", "macro_industry_signal", ">=", 0, "macro and industry proxy confirmation"],
  ["price-valuation-fundamental", "Valuation indicators", "valuation_percentile", "<=", 0.35, "valuation-compression and quality confirmation"],
  ["risk-regime-control", "Volatility/risk indicators", "volatility_percentile_252d", "<=", 0.65, "risk-adjusted participation"],
  ["asset-specific-external", "Asset-specific external source indicators", "asset_specific_external_signal", ">=", 0, "asset-specific external proxy confirmation"],
] as const;

const VARIANTS = [
  ["Relative strength indicators", "relative_strength_vs_primary_benchmark", ">=", 0, "Volatility/risk indicators", "volatility_percentile_252d", "<=", 0.8, "cap exposure in the highest-volatility quintile", "normal-volatility recovery"],
  ["Momentum confirmation indicators", "asset_return_63d", ">=", 0, "Drawdown/recovery indicators", "drawdown_from_52w_high", ">=", -0.35, "avoid unresolved deep drawdowns", "post-drawdown repair"],
  ["Sector rotation indicators", "sector_relative_strength", ">=", 0, "Macro/liquidity indicators", "market_liquidity_regime", ">=", -0.25, "de-risk when leadership and liquidity deteriorate", "sector leadership"],
  ["Quality/profitability indicators", "balance_sheet_or_profitability_quality", ">=", 0, "Volatility/risk indicators", "volatility_percentile_252d", "<=", 0.7, "require quality support during elevated volatility", "quality-resilient"],
  ["Fundamental trend indicators", "fundamental_growth_trend", ">=", 0, "Relative strength indicators", "relative_strength_vs_primary_benchmark", ">=", -0.1, "reduce exposure when sponsorship fails", "fundamental inflection proxy"],
  ["Macro/liquidity indicators", "market_liquidity_regime", ">=", 0, "Drawdown/recovery indicators", "drawdown_from_ath", ">=", -0.5, "avoid structural-impairment drawdowns", "liquidity expansion"],
  ["Commodity sensitivity indicators", "commodity_or_input_trend", ">=", 0, "Sector rotation indicators", "sector_relative_strength", ">=", -0.1, "avoid input-linked stress regimes", "input-cost tailwind proxy"],
  ["Valuation indicators", "valuation_percentile", "<=", 0.6, "Momentum confirmation indicators", "asset_return_126d", ">=", -0.2, "avoid cheap assets with severe momentum", "valuation support with stabilizing trend"],
  ["Drawdown/recovery indicators", "drawdown_from_52w_high", ">=", -0.2, "Macro/liquidity indicators", "benchmark_trend_200d", ">=", 0, "require broad-market support for recovery", "broad risk-on recovery"],
  ["Volatility/risk indicators", "volatility_compression", ">=", 0, "Quality/profitability indicators", "balance_sheet_or_profitability_quality", ">=", -0.25, "size down without quality support", "compressed-volatility breakout"],
] as const;

export function generateStrategyCombinations(thesis = "The documented company thesis"): StrategyCombination[] {
  const combinations: StrategyCombination[] = [];
  for (const blueprint of BLUEPRINTS) {
    for (const variant of VARIANTS) {
      const [
        leadBucket, leadFamily, entryIndicator, entryOperator, entryThreshold, thesisDriver,
      ] = blueprint;
      const [
        confirmationFamily, confirmationIndicator, confirmationOperator, confirmationThreshold,
        riskFamily, riskIndicator, riskOperator, riskThreshold, riskControl, regimeAssumption,
      ] = variant;
      const index = combinations.length + 1;
      const familiesUsed = [...new Set([leadFamily, confirmationFamily, riskFamily])];
      combinations.push({
        combinationKey: `COMBO-${String(index).padStart(3, "0")}`,
        name: `${leadBucket.replaceAll("-", " ")} + ${confirmationFamily.split(" ")[0]} confirmation`,
        leadBucket,
        indicatorsUsed: [...new Set([entryIndicator, confirmationIndicator, riskIndicator])],
        familiesUsed,
        thesisDriver: `${thesisDriver} in a ${regimeAssumption} regime`,
        hypothesis: `If ${thesis} is investable, returns should improve when ${thesisDriver}, ${confirmationIndicator} confirms, and the named risk control holds.`,
        entryRule: `${entryIndicator} ${entryOperator} ${entryThreshold} and ${confirmationIndicator} ${confirmationOperator} ${confirmationThreshold}`,
        exitRule: `Exit when ${entryIndicator} fails or ${riskIndicator} breaches ${riskThreshold}.`,
        riskControl,
        positionSizing: "Long-only at the configured maximum exposure only while entry, confirmation, and risk rules all pass.",
        regimeAssumption,
        whyEconomic: `Combines ${leadFamily}, ${confirmationFamily}, and ${riskFamily} around a named thesis condition.`,
        whyNotCurveFit: "This varies thesis, family mix, risk control, and regime—not small changes to one technical parameter.",
        entryIndicator,
        entryOperator: entryOperator as ComparisonOperator,
        entryThreshold,
        confirmationIndicator,
        confirmationOperator: confirmationOperator as ComparisonOperator,
        confirmationThreshold,
        riskIndicator,
        riskOperator: riskOperator as ComparisonOperator,
        riskThreshold,
        maxPosition: leadBucket === "risk-regime-control" ? 0.75 : 1,
      });
    }
  }
  validateStrategyCombinations(combinations);
  return combinations;
}

export function validateStrategyCombinations(combinations: StrategyCombination[]): void {
  if (combinations.length < MINIMUM_COMBINATION_COUNT) {
    throw new Error(`At least ${MINIMUM_COMBINATION_COUNT} strategy combinations are required; received ${combinations.length}.`);
  }
  if (new Set(combinations.map((item) => item.combinationKey)).size !== combinations.length) {
    throw new Error("Strategy combination keys must be unique.");
  }
  const distinct = new Set<string>();
  const buckets = new Map<string, number>();
  for (const item of combinations) {
    if (new Set(item.familiesUsed).size < 2) {
      throw new Error(`${item.combinationKey} uses fewer than two indicator families.`);
    }
    if (!item.hypothesis || !item.whyNotCurveFit) {
      throw new Error(`${item.combinationKey} is missing its hypothesis or anti-curve-fit rationale.`);
    }
    const key = [item.thesisDriver, item.familiesUsed.join("|"), item.riskControl, item.regimeAssumption].join("::");
    if (distinct.has(key)) throw new Error(`${item.combinationKey} duplicates another combination's research logic.`);
    distinct.add(key);
    buckets.set(item.leadBucket, (buckets.get(item.leadBucket) || 0) + 1);
  }
  for (const [bucket] of BLUEPRINTS) {
    if ((buckets.get(bucket) || 0) < 10) throw new Error(`Strategy bucket ${bucket} has fewer than 10 combinations.`);
  }
}

export function runFrameworkBacktest(
  dataset: MarketDataset,
  combinations: StrategyCombination[],
  transactionCostBps = DEFAULT_TRANSACTION_COST_BPS
): FrameworkBacktestResult {
  validateStrategyCombinations(combinations);
  const normalized = normalizeDataset(dataset);
  if (normalized.dates.length < 260) {
    throw new Error(`Backtest requires at least 260 aligned observations; received ${normalized.dates.length}.`);
  }
  const indicators = buildIndicators(normalized);
  const splitIndex = Math.max(1, Math.min(normalized.dates.length - 1, Math.floor(normalized.dates.length * DEFAULT_SPLIT_RATIO)));
  const assetReturns = returns(normalized.asset);
  const buyHold = performanceSummary(assetReturns, assetReturns.map(() => 1), normalized.dates);
  const benchmarkMetrics: Record<string, PerformanceMetrics> = {
    [`${dataset.symbol}_buy_hold`]: buyHold,
    cash: performanceSummary(assetReturns.map(() => 0), assetReturns.map(() => 0), normalized.dates),
  };
  for (const [symbol, series] of Object.entries(normalized.benchmarks)) {
    benchmarkMetrics[`${symbol}_benchmark`] = performanceSummary(returns(series), series.map(() => 1), normalized.dates);
  }

  const results = combinations.map((combination) => {
    const signal = buildSignal(indicators, combination);
    const positions = signal.map((_, index) => index === 0 ? 0 : signal[index - 1]);
    const strategyReturns = assetReturns.map((assetReturn, index) => {
      const prior = index === 0 ? 0 : positions[index - 1];
      const trade = Math.abs(positions[index] - prior);
      return positions[index] * assetReturn - trade * transactionCostBps / 10_000;
    });
    const equity = cumulativeEquity(strategyReturns);
    const drawdown = drawdownSeries(equity);
    const full = performanceSummary(strategyReturns, positions, normalized.dates);
    const inSample = performanceSummary(strategyReturns.slice(0, splitIndex), positions.slice(0, splitIndex), normalized.dates.slice(0, splitIndex));
    const outOfSample = performanceSummary(strategyReturns.slice(splitIndex), positions.slice(splitIndex), normalized.dates.slice(splitIndex));
    const benchmarkOos = performanceSummary(assetReturns.slice(splitIndex), assetReturns.slice(splitIndex).map(() => 1), normalized.dates.slice(splitIndex));
    const benchmarkRelative = full.total_return - buyHold.total_return;
    const oosExcess = outOfSample.total_return - benchmarkOos.total_return;
    let penalty = 0;
    if (full.max_drawdown < -0.4) penalty += 0.15;
    if (full.number_of_trades < 2 || full.number_of_trades > 120) penalty += 0.1;
    if (full.turnover > 150) penalty += 0.1;
    if (full.exposure_time < 0.05) penalty += 0.1;
    const consistencyScore = full.worst_year > -0.25 ? 1 : 0.5;
    const finalScore =
      0.25 * full.cagr +
      0.2 * (1 + full.max_drawdown) +
      0.15 * Math.max(full.sharpe, full.sortino) +
      0.15 * benchmarkRelative +
      0.1 * outOfSample.total_return +
      0.1 * consistencyScore +
      0.05 -
      penalty;
    const status =
      full.max_drawdown < -0.5 || full.number_of_trades < 2 || finalScore < 0 ? "Rejected" :
      finalScore >= 0.65 && outOfSample.total_return > 0 ? "Robust" :
      finalScore >= 0.35 ? "Promising" :
      finalScore >= 0.15 ? "Needs review" : "Weak";
    return {
      combination_key: combination.combinationKey,
      strategy_name: combination.name,
      lead_bucket: combination.leadBucket,
      indicators_used: combination.indicatorsUsed,
      families_used: combination.familiesUsed,
      status,
      final_score: finite(finalScore),
      metrics: {
        ...full,
        benchmark_relative_return: finite(benchmarkRelative),
        out_of_sample_return: outOfSample.total_return,
        out_of_sample_excess_return: finite(oosExcess),
        in_sample: inSample,
        out_of_sample: outOfSample,
        parameter_stability: {
          family_peer_count: 0,
          family_peer_mean_oos_return: 0,
          positive_family_peer_fraction: 0,
        },
        split_date: normalized.dates[splitIndex],
        transaction_cost_bps: transactionCostBps,
        selection_rule: "Catalog fixed before execution; ranking uses full metrics while out-of-sample performance is shown separately.",
      },
      equity,
      drawdown,
      positions,
    } satisfies CombinationResult;
  });

  for (const result of results) {
    const peers = results.filter((candidate) =>
      candidate !== result &&
      candidate.lead_bucket === result.lead_bucket
    );
    const peerReturns = peers.map((candidate) => candidate.metrics.out_of_sample.total_return);
    result.metrics.parameter_stability = {
      family_peer_count: peers.length,
      family_peer_mean_oos_return: finite(mean(peerReturns)),
      positive_family_peer_fraction: peers.length ? peers.filter((value) => value.metrics.out_of_sample.total_return > 0).length / peers.length : 0,
    };
  }
  const rankings = [...results].sort((a, b) => b.final_score - a.final_score);
  return {
    observations: normalized.dates.length,
    dates: normalized.dates,
    split_date: normalized.dates[splitIndex],
    split_ratio: DEFAULT_SPLIT_RATIO,
    transaction_cost_bps: transactionCostBps,
    indicators,
    combinations: results,
    rankings,
    benchmark_metrics: benchmarkMetrics,
    source_alignment: [
      {
        dataset: dataset.symbol,
        source: dataset.source === "yahoo" ? "Yahoo Finance adjusted daily prices and volume" : "Deterministic synthetic acceptance fixture",
        release_or_observation_date_used: true,
        classification: "backtest_ready",
        lookahead_risk: "Daily observations only; signal at t is shifted to t+1.",
        notes: "Asset buy-and-hold benchmark and price/volume indicators.",
      },
      ...Object.keys(normalized.benchmarks).map((symbol) => ({
        dataset: symbol,
        source: dataset.source === "yahoo" ? "Yahoo Finance adjusted daily prices" : "Deterministic synthetic acceptance fixture",
        release_or_observation_date_used: true,
        classification: "backtest_ready" as const,
        lookahead_risk: "Daily observation-date alignment; no forward fill before first available observation.",
        notes: "Primary, sector, or broad-market benchmark.",
      })),
      {
        dataset: "Fundamental and asset-specific external indicators",
        source: "Price-derived proxy columns pending release-date historical datasets",
        release_or_observation_date_used: true,
        classification: "backtestable_with_caution",
        lookahead_risk: "No current fundamental value is backfilled into history.",
        notes: "Proxy results cannot establish fundamental timing efficacy; replace with point-in-time source histories.",
      },
    ],
  };
}

type NormalizedDataset = {
  dates: string[];
  asset: number[];
  volume: number[];
  benchmarks: Record<string, number[]>;
  primaryBenchmark: string;
  sectorBenchmark: string;
  broadBenchmark: string;
};

function normalizeDataset(dataset: MarketDataset): NormalizedDataset {
  const assetMap = new Map(dataset.asset.map((bar) => [dateKey(bar.trading_date), bar]));
  const benchmarkMaps = Object.fromEntries(
    Object.entries(dataset.benchmarks).map(([symbol, bars]) => [
      symbol,
      new Map(bars.map((bar) => [dateKey(bar.trading_date), Number(bar.adjusted_close ?? bar.close)])),
    ])
  );
  const dates = [...assetMap.keys()].sort().filter((date) =>
    Object.values(benchmarkMaps).every((map) => map.has(date))
  );
  return {
    dates,
    asset: dates.map((date) => Number(assetMap.get(date)!.adjusted_close ?? assetMap.get(date)!.close)),
    volume: dates.map((date) => Number(assetMap.get(date)!.volume || 0)),
    benchmarks: Object.fromEntries(Object.entries(benchmarkMaps).map(([symbol, map]) => [symbol, dates.map((date) => map.get(date)!)])),
    primaryBenchmark: dataset.primaryBenchmark,
    sectorBenchmark: dataset.sectorBenchmark,
    broadBenchmark: dataset.broadBenchmark,
  };
}

function buildIndicators(dataset: NormalizedDataset): Record<string, Array<number | null>> {
  const asset63 = rollingReturn(dataset.asset, 63);
  const asset126 = rollingReturn(dataset.asset, 126);
  const drawdown52 = rollingDrawdown(dataset.asset, 252);
  const drawdownAth = cumulativeDrawdown(dataset.asset);
  const vol21 = rollingVolatility(dataset.asset, 21);
  const vol63 = rollingVolatility(dataset.asset, 63);
  const vol126 = rollingVolatility(dataset.asset, 126);
  const volPercentile = rollingPercentile(vol63, 252);
  const primary = dataset.benchmarks[dataset.primaryBenchmark] || dataset.benchmarks[dataset.broadBenchmark];
  const sector = dataset.benchmarks[dataset.sectorBenchmark] || primary;
  const broad = dataset.benchmarks[dataset.broadBenchmark] || primary;
  const primary63 = rollingReturn(primary, 63);
  const sector63 = rollingReturn(sector, 63);
  const broad63 = rollingReturn(broad, 63);
  const broadMa = movingAverage(broad, 200);
  const assetMa = movingAverage(dataset.asset, 200);
  const valuationRaw = dataset.asset.map((value, i) => assetMa[i] == null ? null : value / assetMa[i]!);
  const signedVolume = dataset.volume.map((volume, i) => i === 0 ? 0 : (dataset.asset[i] >= dataset.asset[i - 1] ? volume : -volume));
  const volumeBalance = rollingRatio(signedVolume, dataset.volume, 63);

  const indicators: Record<string, Array<number | null>> = {
    asset_return_63d: asset63,
    asset_return_126d: asset126,
    drawdown_from_52w_high: drawdown52,
    drawdown_from_ath: drawdownAth,
    volatility_percentile_252d: volPercentile,
    volatility_compression: map2(vol21, vol126, (short, long) => long === 0 ? 0 : 1 - short / long),
    relative_strength_vs_primary_benchmark: map2(asset63, primary63, (asset, benchmark) => asset - benchmark),
    sector_relative_strength: map2(sector63, broad63, (sectorReturn, broadReturn) => sectorReturn - broadReturn),
    benchmark_trend_200d: broad.map((value, i) => broadMa[i] == null ? null : value / broadMa[i]! - 1),
    market_liquidity_regime: map2(primary63, broad63, (primaryReturn, broadReturn) => (primaryReturn + broadReturn) / 2),
    macro_industry_signal: map3(
      broad.map((value, i) => broadMa[i] == null ? null : value / broadMa[i]! - 1),
      primary63,
      map2(sector63, broad63, (sectorReturn, broadReturn) => sectorReturn - broadReturn),
      (trend, primaryReturn, sectorRelative) => (trend + primaryReturn + sectorRelative) / 3
    ),
    valuation_percentile: rollingPercentile(valuationRaw, 252),
    balance_sheet_or_profitability_quality: map2(asset126, vol63, (momentum, volatility) => momentum - volatility),
    fundamental_growth_trend: map2(asset63, asset126, (short, medium) => 0.4 * short + 0.6 * medium),
    commodity_or_input_trend: map2(sector63, primary63, (sectorReturn, primaryReturn) => sectorReturn - primaryReturn),
    asset_specific_external_signal: map2(volumeBalance, map2(asset63, primary63, (asset, benchmark) => asset - benchmark), (volume, relative) => 0.5 * volume + 0.5 * relative),
  };
  return indicators;
}

function buildSignal(indicators: Record<string, Array<number | null>>, combination: StrategyCombination): number[] {
  const length = Object.values(indicators)[0]?.length || 0;
  return Array.from({ length }, (_, index) => {
    const entry = compare(indicators[combination.entryIndicator]?.[index], combination.entryOperator, combination.entryThreshold);
    const confirmation = compare(indicators[combination.confirmationIndicator]?.[index], combination.confirmationOperator, combination.confirmationThreshold);
    const risk = compare(indicators[combination.riskIndicator]?.[index], combination.riskOperator, combination.riskThreshold);
    return entry && confirmation && risk ? combination.maxPosition : 0;
  });
}

function performanceSummary(stream: number[], positions: number[], dates: string[]): PerformanceMetrics {
  if (!stream.length) return emptyMetrics();
  const equity = cumulativeEquity(stream);
  const years = Math.max(stream.length / 252, 1 / 252);
  const totalReturn = equity[equity.length - 1] - 1;
  const cagr = Math.pow(Math.max(equity[equity.length - 1], 1e-9), 1 / years) - 1;
  const volatility = standardDeviation(stream) * Math.sqrt(252);
  const avg = mean(stream);
  const downside = stream.filter((value) => value < 0);
  const downsideVol = standardDeviation(downside) * Math.sqrt(252);
  const sharpe = volatility ? avg * 252 / volatility : 0;
  const sortino = downsideVol ? avg * 252 / downsideVol : 0;
  const drawdown = drawdownSeries(equity);
  const maxDrawdown = Math.min(...drawdown);
  const changes = positions.map((position, index) => Math.abs(position - (index ? positions[index - 1] : 0)));
  const activeReturns = stream.filter((value) => value !== 0);
  const wins = activeReturns.filter((value) => value > 0);
  const losses = activeReturns.filter((value) => value < 0);
  const annual = new Map<string, number[]>();
  dates.forEach((date, index) => {
    const year = date.slice(0, 4);
    annual.set(year, [...(annual.get(year) || []), stream[index] || 0]);
  });
  const annualReturns = [...annual.values()].map((values) => cumulativeEquity(values).at(-1)! - 1);
  return {
    cagr: finite(cagr),
    total_return: finite(totalReturn),
    volatility: finite(volatility),
    sharpe: finite(sharpe),
    sortino: finite(sortino),
    max_drawdown: finite(maxDrawdown),
    calmar: maxDrawdown ? finite(cagr / Math.abs(maxDrawdown)) : 0,
    exposure_time: positions.filter((value) => value > 0).length / Math.max(positions.length, 1),
    number_of_trades: changes.filter((value) => value > 0).length,
    win_rate: wins.length / Math.max(activeReturns.length, 1),
    average_win: finite(mean(wins)),
    average_loss: finite(mean(losses)),
    profit_factor: losses.length ? finite(sum(wins) / Math.abs(sum(losses))) : 0,
    turnover: finite(sum(changes)),
    best_year: annualReturns.length ? Math.max(...annualReturns) : 0,
    worst_year: annualReturns.length ? Math.min(...annualReturns) : 0,
  };
}

function emptyMetrics(): PerformanceMetrics {
  return {
    cagr: 0, total_return: 0, volatility: 0, sharpe: 0, sortino: 0,
    max_drawdown: 0, calmar: 0, exposure_time: 0, number_of_trades: 0,
    win_rate: 0, average_win: 0, average_loss: 0, profit_factor: 0,
    turnover: 0, best_year: 0, worst_year: 0,
  };
}

function rollingReturn(values: number[], window: number): Array<number | null> {
  return values.map((value, index) => index < window ? null : value / values[index - window] - 1);
}

function returns(values: number[]): number[] {
  return values.map((value, index) => index === 0 ? 0 : value / values[index - 1] - 1);
}

function rollingDrawdown(values: number[], window: number): Array<number | null> {
  return values.map((value, index) => {
    if (index < Math.min(window - 1, 20)) return null;
    return value / Math.max(...values.slice(Math.max(0, index - window + 1), index + 1)) - 1;
  });
}

function cumulativeDrawdown(values: number[]): Array<number | null> {
  let high = -Infinity;
  return values.map((value) => {
    high = Math.max(high, value);
    return value / high - 1;
  });
}

function movingAverage(values: number[], window: number): Array<number | null> {
  return values.map((_, index) => index < window - 1 ? null : mean(values.slice(index - window + 1, index + 1)));
}

function rollingVolatility(values: number[], window: number): Array<number | null> {
  const stream = returns(values);
  return stream.map((_, index) => index < window - 1 ? null : standardDeviation(stream.slice(index - window + 1, index + 1)) * Math.sqrt(252));
}

function rollingPercentile(values: Array<number | null>, window: number): Array<number | null> {
  return values.map((value, index) => {
    if (value == null || index < Math.min(63, window - 1)) return null;
    const sample = values.slice(Math.max(0, index - window + 1), index + 1).filter((item): item is number => item != null);
    if (sample.length < 20) return null;
    return sample.filter((item) => item <= value).length / sample.length;
  });
}

function rollingRatio(numerator: number[], denominator: number[], window: number): Array<number | null> {
  return numerator.map((_, index) => {
    if (index < window - 1) return null;
    const den = sum(denominator.slice(index - window + 1, index + 1));
    return den ? sum(numerator.slice(index - window + 1, index + 1)) / den : 0;
  });
}

function map2(
  a: Array<number | null>,
  b: Array<number | null>,
  callback: (a: number, b: number) => number
): Array<number | null> {
  return a.map((value, index) => value == null || b[index] == null ? null : finite(callback(value, b[index]!)));
}

function map3(
  a: Array<number | null>,
  b: Array<number | null>,
  c: Array<number | null>,
  callback: (a: number, b: number, c: number) => number
): Array<number | null> {
  return a.map((value, index) => value == null || b[index] == null || c[index] == null ? null : finite(callback(value, b[index]!, c[index]!)));
}

function compare(value: number | null | undefined, operator: ComparisonOperator, threshold: number): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  if (operator === ">=") return value >= threshold;
  if (operator === ">") return value > threshold;
  if (operator === "<=") return value <= threshold;
  return value < threshold;
}

function cumulativeEquity(stream: number[]): number[] {
  let equity = 1;
  return stream.map((value) => {
    equity *= 1 + value;
    return finite(equity);
  });
}

function drawdownSeries(equity: number[]): number[] {
  let high = -Infinity;
  return equity.map((value) => {
    high = Math.max(high, value);
    return finite(value / high - 1);
  });
}

function standardDeviation(values: number[]): number {
  if (!values.length) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
