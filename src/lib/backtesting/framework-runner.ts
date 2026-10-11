import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createYahooMarketDataProvider } from "@/lib/market-data/providers/yahoo";
import { timedFetch } from "@/lib/market-data/price-history";
import { deterministicBars } from "@/lib/market-data/providers/mock";
import type { PriceBar } from "@/lib/market-data/provider";
import type { ResearchRunContext } from "@/lib/research/run-context";
import {
  generateStrategyCombinations,
  runFrameworkBacktest,
  type FrameworkBacktestResult,
  type MarketDataset,
  type StrategyCombination,
} from "./framework";

const SOFI_BENCHMARKS = ["QQQ", "XLF", "KRE", "SPY"] as const;

export interface FrameworkBenchmarkConfig {
  symbols: string[];
  primaryBenchmark: string;
  sectorBenchmark: string | null;
  broadBenchmark: string;
}

/** SPDR sector ETFs by sector name, in GICS and common data-provider spellings. */
const SECTOR_ETFS: Record<string, string> = {
  "information technology": "XLK", technology: "XLK", "communication services": "XLC",
  "consumer discretionary": "XLY", "consumer cyclical": "XLY", "consumer staples": "XLP", "consumer defensive": "XLP",
  "health care": "XLV", healthcare: "XLV", industrials: "XLI", energy: "XLE", materials: "XLB", "basic materials": "XLB",
  utilities: "XLU", "real estate": "XLRE", financials: "XLF", "financial services": "XLF",
};

/**
 * Benchmarks for one asset: QQQ (growth market), SPY (broad market) and the ETF of the asset's
 * sector. Banks add the regional-bank ETF. An unknown sector gets no sector benchmark.
 */
export function frameworkBenchmarks(sector: string | null | undefined, bank = false): FrameworkBenchmarkConfig {
  const sectorBenchmark = SECTOR_ETFS[String(sector ?? "").trim().toLowerCase()] ?? (bank ? "XLF" : null);
  return {
    symbols: [...new Set(["QQQ", ...(sectorBenchmark ? [sectorBenchmark] : []), ...(bank ? ["KRE"] : []), "SPY"])],
    primaryBenchmark: "QQQ",
    sectorBenchmark,
    broadBenchmark: "SPY",
  };
}

export async function loadFrameworkMarketDataset(
  ctx: ResearchRunContext,
  benchmarkConfig: FrameworkBenchmarkConfig = {
    symbols: [...SOFI_BENCHMARKS],
    primaryBenchmark: "QQQ",
    sectorBenchmark: "XLF",
    broadBenchmark: "SPY",
  }
): Promise<MarketDataset> {
  const end = ctx.marketDataCutoffAt || ctx.cutoffAt || new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 6);

  if (ctx.testMode || process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock") {
    const benchmarks = Object.fromEntries(
      benchmarkConfig.symbols.map((symbol, index) => [
        symbol,
        syntheticSeries(symbol, 35 + index * 40, 1550, 7 + index * 6),
      ])
    );
    return {
      symbol: ctx.symbol,
      asset: syntheticSeries(ctx.symbol, 11, 1550, 0),
      benchmarks,
      primaryBenchmark: benchmarkConfig.primaryBenchmark,
      sectorBenchmark: benchmarkConfig.sectorBenchmark,
      broadBenchmark: benchmarkConfig.broadBenchmark,
      source: "synthetic_fixture",
    };
  }

  // Each series gets a 20 s timeout and one retry: one throttled benchmark should not end the run.
  const yahoo = createYahooMarketDataProvider(timedFetch);
  const history = (symbol: string) => yahoo.getPriceHistory(symbol, start, end, "1d")
    .catch(() => yahoo.getPriceHistory(symbol, start, end, "1d"));
  const [asset, ...benchmarks] = await Promise.all([history(ctx.symbol), ...benchmarkConfig.symbols.map(history)]);
  return {
    symbol: ctx.symbol,
    asset,
    benchmarks: Object.fromEntries(
      benchmarkConfig.symbols.map((symbol, index) => [symbol, benchmarks[index]])
    ),
    primaryBenchmark: benchmarkConfig.primaryBenchmark,
    sectorBenchmark: benchmarkConfig.sectorBenchmark,
    broadBenchmark: benchmarkConfig.broadBenchmark,
    source: "yahoo",
  };
}

function syntheticSeries(
  symbol: string,
  startPrice: number,
  count: number,
  phase: number
): PriceBar[] {
  const base = deterministicBars(symbol, startPrice, count);
  return base.map((bar, index) => {
    const cycle = Math.sin((index + phase) / 17) * 0.012;
    const trend = 1 + index * 0.00012;
    const adjusted = Number(bar.adjusted_close ?? bar.close) * trend * (1 + cycle);
    return {
      ...bar,
      open: adjusted * 0.995,
      high: adjusted * 1.015,
      low: adjusted * 0.985,
      close: adjusted,
      adjusted_close: adjusted,
      volume: 1_000_000 + ((index + phase) % 31) * 37_000,
    };
  });
}

export async function executeFrameworkBacktest(
  ctx: ResearchRunContext,
  combinations?: StrategyCombination[],
  benchmarkConfig?: FrameworkBenchmarkConfig
): Promise<{
  dataset: MarketDataset;
  combinations: StrategyCombination[];
  result: FrameworkBacktestResult;
  artifacts: Array<{
    artifact_type: string;
    title: string;
    storage_path: string;
    mime_type: string;
    metadata_json: Record<string, unknown>;
  }>;
}> {
  const dataset = await loadFrameworkMarketDataset(ctx, benchmarkConfig);
  const catalog = combinations || generateStrategyCombinations(ctx.researchQuestion || ctx.assetName);
  const result = runFrameworkBacktest(dataset, catalog);
  const artifactDir = join(process.cwd(), "storage", "backtests", ctx.runId, "framework");
  await mkdir(artifactDir, { recursive: true });

  const rankingsPath = join(artifactDir, "combo_rankings.json");
  const resultsPath = join(artifactDir, "combo_results.csv");
  const equityPath = join(artifactDir, "equity_curve_top_strategies.svg");
  const drawdownPath = join(artifactDir, "drawdown_top_strategies.svg");
  const scorePath = join(artifactDir, "combo_score_ranking.svg");

  await writeFile(
    rankingsPath,
    JSON.stringify({
      setup: {
        symbol: dataset.symbol,
        benchmark_symbols: Object.keys(dataset.benchmarks),
        observations: result.observations,
        split_date: result.split_date,
        split_ratio: result.split_ratio,
        transaction_cost_bps: result.transaction_cost_bps,
      },
      source_alignment: result.source_alignment,
      benchmark_metrics: result.benchmark_metrics,
      rankings: result.rankings.map(stripTimeseries),
    }, null, 2),
    "utf8"
  );
  await writeFile(resultsPath, renderResultsCsv(result.rankings), "utf8");
  await writeFile(equityPath, renderLineSvg(result, "equity"), "utf8");
  await writeFile(drawdownPath, renderLineSvg(result, "drawdown"), "utf8");
  await writeFile(scorePath, renderScoreSvg(result), "utf8");

  const artifacts = [
    artifact("combo_rankings", "Strategy combination rankings", rankingsPath, "application/json", { combinations: result.rankings.length }),
    artifact("combo_results", "Strategy combination result table", resultsPath, "text/csv", { combinations: result.rankings.length }),
    artifact("equity_curves", "Top strategy equity curves", equityPath, "image/svg+xml", { top_count: 10 }),
    artifact("drawdown_curves", "Top strategy drawdown curves", drawdownPath, "image/svg+xml", { top_count: 10 }),
    artifact("score_ranking", "Strategy score ranking", scorePath, "image/svg+xml", { top_count: 20 }),
  ];

  return { dataset, combinations: catalog, result, artifacts };
}

function stripTimeseries(result: FrameworkBacktestResult["rankings"][number]) {
  const { equity: _equity, drawdown: _drawdown, positions: _positions, ...summary } = result;
  return summary;
}

function artifact(
  artifact_type: string,
  title: string,
  absolutePath: string,
  mime_type: string,
  metadata_json: Record<string, unknown>
) {
  return {
    artifact_type,
    title,
    storage_path: relative(process.cwd(), absolutePath).replaceAll("\\", "/"),
    mime_type,
    metadata_json,
  };
}

function renderResultsCsv(rankings: FrameworkBacktestResult["rankings"]): string {
  const headers = [
    "rank", "combination_key", "strategy_name", "status", "final_score", "cagr",
    "total_return", "max_drawdown", "sharpe", "sortino", "out_of_sample_return",
    "out_of_sample_excess_return", "benchmark_relative_return", "number_of_trades",
    "exposure_time", "turnover",
  ];
  const rows = rankings.map((item, index) => [
    index + 1,
    item.combination_key,
    item.strategy_name,
    item.status,
    item.final_score,
    item.metrics.cagr,
    item.metrics.total_return,
    item.metrics.max_drawdown,
    item.metrics.sharpe,
    item.metrics.sortino,
    item.metrics.out_of_sample_return,
    item.metrics.out_of_sample_excess_return,
    item.metrics.benchmark_relative_return,
    item.metrics.number_of_trades,
    item.metrics.exposure_time,
    item.metrics.turnover,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderLineSvg(result: FrameworkBacktestResult, field: "equity" | "drawdown"): string {
  const width = 1200;
  const height = 640;
  const padding = 55;
  const top = result.rankings.slice(0, 10);
  const values = top.flatMap((item) => item[field]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = Math.max(maximum - minimum, 1e-9);
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#4f46e5", "#be123c", "#65a30d", "#a16207"];
  const paths = top.map((item, seriesIndex) => {
    const points = item[field].map((value, index) => {
      const x = padding + index / Math.max(item[field].length - 1, 1) * (width - padding * 2);
      const y = height - padding - (value - minimum) / span * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<polyline fill="none" stroke="${colors[seriesIndex]}" stroke-width="1.5" points="${points}"/>`;
  }).join("\n");
  const legend = top.map((item, index) =>
    `<text x="${padding + (index % 5) * 215}" y="${22 + Math.floor(index / 5) * 20}" font-size="12" fill="${colors[index]}">${escapeXml(item.combination_key)}</text>`
  ).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/>
${legend}
<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#94a3b8"/>
<line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#94a3b8"/>
${paths}
</svg>\n`;
}

function renderScoreSvg(result: FrameworkBacktestResult): string {
  const top = result.rankings.slice(0, 20);
  const width = 1200;
  const height = 650;
  const left = 120;
  const max = Math.max(...top.map((item) => Math.abs(item.final_score)), 1);
  const bars = top.map((item, index) => {
    const y = 20 + index * 30;
    const barWidth = Math.abs(item.final_score) / max * 900;
    const color = item.final_score >= 0 ? "#2563eb" : "#dc2626";
    return `<text x="8" y="${y + 16}" font-size="11">${escapeXml(item.combination_key)}</text>
<rect x="${left}" y="${y}" width="${barWidth.toFixed(1)}" height="20" fill="${color}"/>
<text x="${left + barWidth + 6}" y="${y + 15}" font-size="11">${item.final_score.toFixed(3)}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/>
${bars}
</svg>\n`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
