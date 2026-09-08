import { NextRequest } from "next/server";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, listings } from "@/db/schema/core";
import { market_price_bars } from "@/db/schema/market-data";
import { metric_definitions, metric_observations } from "@/db/schema/metrics";
import { scenarios, valuation_signals } from "@/db/schema/valuation";
import { research_runs } from "@/db/schema/workflow";
import { handleApiError, ApiError, successResponse } from "@/lib/api/errors";
import {
  chartViewConfigSchema,
  resolveChartRange,
  seriesId,
  type ChartSeriesConfig,
} from "@/lib/charts/config";
import {
  alignChartSeries,
  checkSeriesCompatibility,
  type ChartSeries,
} from "@/lib/charts/data";
import { createMarketDataService } from "@/lib/market-data/service";
import { createYahooMarketDataProvider } from "@/lib/market-data/providers/yahoo";
import { MarketDataError } from "@/lib/market-data/provider";

type AssetMeta = { id: string; name: string };

const yahooMarketData = createMarketDataService({
  db,
  defaultProvider: createYahooMarketDataProvider(),
  providerName: "yahoo",
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => {
      throw new ApiError("Chart request body must be valid JSON", 400, "INVALID_CHART_REQUEST");
    });
    const config = chartViewConfigSchema.parse(body?.config ?? body);
    const { start, end } = resolveChartRange(config.range);
    const requestedAssets = new Set(config.assetIds);
    const availableAssets = await db
      .select({ id: assets.id, name: assets.canonical_name })
      .from(assets)
      .where(inArray(assets.id, [...requestedAssets]));
    if (availableAssets.length !== requestedAssets.size) {
      throw new ApiError("One or more chart assets do not exist", 404, "ASSET_NOT_FOUND");
    }
    const metadata = new Map(availableAssets.map((asset) => [asset.id, asset]));

    const runAssignments = config.series.flatMap((series) => {
      // A selected run belongs to the anchor asset. Comparison assets need an
      // explicit per-series runId; price bars are independent of research runs.
      const runId = series.runId ?? (series.assetId === config.anchorAssetId ? config.runId : undefined);
      return runId ? [{ runId, assetId: series.assetId }] : [];
    });
    const runIds = [...new Set(runAssignments.map((assignment) => assignment.runId))];
    if (runIds.length > 0) {
      const runs = await db
        .select({ id: research_runs.id, assetId: research_runs.asset_id })
        .from(research_runs)
        .where(inArray(research_runs.id, runIds));
      const runMap = new Map(runs.map((run) => [run.id, run.assetId]));
      for (const assignment of runAssignments) {
        const ownerAssetId = runMap.get(assignment.runId);
        if (!ownerAssetId) throw new ApiError("Chart run does not exist", 404, "RUN_NOT_FOUND");
        if (ownerAssetId !== assignment.assetId) {
          throw new ApiError("Chart run does not belong to the series asset", 400, "RUN_ASSET_MISMATCH");
        }
      }
    }

    const priceAssetIds = [...new Set(
      config.series.filter((series) => series.kind === "price").map((series) => series.assetId),
    )];
    await Promise.all(priceAssetIds.map((assetId) => hydrateYahooPriceHistory(assetId, start, end)));

    const loaded = await Promise.all(
      config.series.map((series) => {
        const seriesRunId = series.runId ?? (series.assetId === config.anchorAssetId ? config.runId : undefined);
        return loadSeries(series, metadata.get(series.assetId)!, seriesRunId, start, end);
      })
    );
    const compatibility = checkSeriesCompatibility(loaded, config.normalization);
    if (!compatibility.compatible) {
      throw new ApiError(compatibility.reason ?? "Incompatible chart series", 400, "INCOMPATIBLE_SERIES");
    }

    const series = alignChartSeries(loaded, config.normalization);
    return successResponse({
      config,
      range: { start: start?.toISOString() ?? null, end: end.toISOString() },
      series,
      warnings: buildWarnings(series),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

async function hydrateYahooPriceHistory(assetId: string, start: Date | null, end: Date) {
  const [instrument] = await db
    .select({ id: instruments.id, symbol: listings.symbol })
    .from(instruments)
    .innerJoin(listings, eq(listings.instrument_id, instruments.id))
    .where(eq(instruments.asset_id, assetId))
    .orderBy(desc(listings.is_primary), asc(listings.symbol), desc(instruments.updated_at))
    .limit(1);
  if (!instrument?.symbol) return;

  if (!start) {
    const [cached] = await db
      .select({ id: market_price_bars.id })
      .from(market_price_bars)
      .where(eq(market_price_bars.instrument_id, instrument.id))
      .limit(1);
    if (cached) return;
  }

  try {
    await yahooMarketData.getPriceHistory(instrument.id, instrument.symbol, start ?? new Date(0), end, "1d");
  } catch (error) {
    if (error instanceof MarketDataError) {
      throw new ApiError(
        `Yahoo price history unavailable: ${error.message}`,
        error.code === "rate_limited" ? 429 : 502,
        `YAHOO_${error.code.toUpperCase()}`,
      );
    }
    throw error;
  }
}

async function loadSeries(
  definition: ChartSeriesConfig,
  asset: AssetMeta,
  configRunId: string | undefined,
  start: Date | null,
  end: Date,
): Promise<ChartSeries> {
  const runId = definition.runId ?? configRunId;
  if (definition.kind === "price") return loadPriceSeries(definition, asset, start, end);
  if (definition.kind === "metric") return loadMetricSeries(definition, asset, runId, start, end);
  if (definition.kind === "valuation") return loadValuationSeries(definition, asset, runId, start, end);
  return loadScenarioSeries(definition, asset, runId, start, end);
}

async function loadPriceSeries(
  definition: ChartSeriesConfig,
  asset: AssetMeta,
  start: Date | null,
  end: Date,
): Promise<ChartSeries> {
  const [instrument] = await db
    .select({ id: instruments.id })
    .from(instruments)
    .leftJoin(listings, eq(listings.instrument_id, instruments.id))
    .where(eq(instruments.asset_id, asset.id))
    .orderBy(desc(listings.is_primary), asc(listings.symbol), desc(instruments.updated_at))
    .limit(1);

  if (!instrument) return emptySeries(definition, asset, "market_price_bars");

  const where = [eq(market_price_bars.instrument_id, instrument.id), lte(market_price_bars.trading_date, end)];
  if (start) where.push(gte(market_price_bars.trading_date, start));
  const rows = await db
    .select()
    .from(market_price_bars)
    .where(and(...where))
    .orderBy(
      asc(market_price_bars.trading_date),
      desc(market_price_bars.retrieved_at),
      asc(market_price_bars.provider),
      asc(market_price_bars.provider_symbol),
    );

  // Multiple providers can cache the same day. Keep the first (latest retrieved)
  // observation per day and never ask a provider for missing data here.
  const seen = new Set<string>();
  const points = rows.flatMap((row) => {
    const time = row.trading_date.toISOString();
    const day = time.slice(0, 10);
    if (seen.has(day)) return [];
    seen.add(day);
    const raw = definition.key === "adjusted_close"
      ? row.adjusted_close ?? row.close
      : definition.key === "open"
        ? row.open
        : definition.key === "high"
          ? row.high
          : definition.key === "low"
            ? row.low
            : row.close;
    const value = Number(raw);
    return Number.isFinite(value) ? [{ time, value }] : [];
  });
  const currency = rows.find((row) => row.currency)?.currency ?? null;
  return {
    id: seriesId(definition),
    assetId: asset.id,
    key: definition.key,
    kind: definition.kind,
    label: definition.label ?? `${asset.name} · ${definition.key === "adjusted_close" ? "Adjusted price" : "Price"}`,
    unit: "price",
    currency,
    source: "market_price_bars",
    asOf: points.at(-1)?.time ?? null,
    stale: points.length === 0,
    points,
  };
}

async function loadMetricSeries(
  definition: ChartSeriesConfig,
  asset: AssetMeta,
  runId: string | undefined,
  start: Date | null,
  end: Date,
): Promise<ChartSeries> {
  const where = [eq(metric_observations.asset_id, asset.id), eq(metric_definitions.metric_key, definition.key)];
  if (runId) where.push(eq(metric_observations.research_run_id, runId));
  const rows = await db
    .select({
      period: metric_observations.period_start,
      asOf: metric_observations.as_of_date,
      availableAt: metric_observations.available_at,
      createdAt: metric_observations.created_at,
      value: metric_observations.value_numeric,
      unit: metric_observations.unit,
      currency: metric_observations.currency,
      provider: metric_observations.data_provider,
      displayName: metric_definitions.display_name,
    })
    .from(metric_observations)
    .innerJoin(metric_definitions, eq(metric_observations.metric_definition_id, metric_definitions.id))
    .where(and(...where))
    .orderBy(asc(metric_observations.period_start), desc(metric_observations.created_at));

  const points = dedupePoints(
    rows.flatMap((row) => {
      const date = row.period ?? row.asOf ?? row.availableAt ?? row.createdAt;
      const value = row.value == null ? null : Number(row.value);
      const timestamp = toChartDate(date);
      if (!date || !Number.isFinite(timestamp.getTime()) || (start && timestamp < start) || timestamp > end || (value != null && !Number.isFinite(value))) return [];
      return [{ time: timestamp.toISOString(), value }];
    }),
  );
  const last = rows.at(-1);
  return {
    id: seriesId(definition),
    assetId: asset.id,
    key: definition.key,
    kind: definition.kind,
    label: definition.label ?? last?.displayName ?? `${asset.name} · ${definition.key}`,
    unit: definition.unit ?? last?.unit ?? null,
    currency: definition.currency ?? last?.currency ?? null,
    source: last?.provider ?? "metric_observations",
    asOf: points.at(-1)?.time ?? null,
    stale: points.length === 0,
    points,
  };
}

async function loadValuationSeries(
  definition: ChartSeriesConfig,
  asset: AssetMeta,
  runId: string | undefined,
  start: Date | null,
  end: Date,
): Promise<ChartSeries> {
  const where = [eq(valuation_signals.asset_id, asset.id), eq(valuation_signals.signal_key, definition.key)];
  if (runId) where.push(eq(valuation_signals.research_run_id, runId));
  const rows = await db
    .select({ value: valuation_signals.current_value, createdAt: valuation_signals.created_at, name: valuation_signals.signal_name, currency: valuation_signals.metadata_json })
    .from(valuation_signals)
    .where(and(...where))
    .orderBy(asc(valuation_signals.created_at));
  const points = rows.flatMap((row) => {
    const value = row.value == null ? null : Number(row.value);
    if (value == null || !Number.isFinite(value) || (start && row.createdAt < start) || row.createdAt > end) return [];
    return [{ time: row.createdAt.toISOString(), value }];
  });
  return {
    id: seriesId(definition),
    assetId: asset.id,
    key: definition.key,
    kind: definition.kind,
    label: definition.label ?? rows.at(-1)?.name ?? `${asset.name} · ${definition.key}`,
    unit: definition.unit ?? "price",
    currency: definition.currency ?? inferCurrency(rows.at(-1)?.currency),
    source: "valuation_signals",
    asOf: points.at(-1)?.time ?? null,
    stale: points.length === 0,
    points,
  };
}

async function loadScenarioSeries(
  definition: ChartSeriesConfig,
  asset: AssetMeta,
  runId: string | undefined,
  start: Date | null,
  end: Date,
): Promise<ChartSeries> {
  const where = [eq(scenarios.asset_id, asset.id)];
  if (runId) where.push(eq(scenarios.research_run_id, runId));
  if (definition.key) where.push(eq(scenarios.scenario_type, definition.key));
  const rows = await db
    .select({ value: scenarios.value_anchor, createdAt: scenarios.created_at, name: scenarios.scenario_name, currency: scenarios.currency })
    .from(scenarios)
    .where(and(...where))
    .orderBy(asc(scenarios.created_at));
  const points = rows.flatMap((row) => {
    const value = row.value == null ? null : Number(row.value);
    if (value == null || !Number.isFinite(value) || (start && row.createdAt < start) || row.createdAt > end) return [];
    return [{ time: row.createdAt.toISOString(), value }];
  });
  return {
    id: seriesId(definition),
    assetId: asset.id,
    key: definition.key,
    kind: definition.kind,
    label: definition.label ?? rows.at(-1)?.name ?? `${asset.name} · ${definition.key}`,
    unit: definition.unit ?? "price",
    currency: definition.currency ?? rows.at(-1)?.currency ?? null,
    source: "scenarios",
    asOf: points.at(-1)?.time ?? null,
    stale: points.length === 0,
    points,
  };
}

function emptySeries(definition: ChartSeriesConfig, asset: AssetMeta, source: string): ChartSeries {
  return {
    id: seriesId(definition),
    assetId: asset.id,
    key: definition.key,
    kind: definition.kind,
    label: definition.label ?? `${asset.name} · ${definition.key}`,
    unit: definition.kind === "price" ? "price" : definition.unit ?? null,
    currency: definition.currency ?? null,
    source,
    asOf: null,
    stale: true,
    points: [],
  };
}

function dedupePoints(points: { time: string; value: number | null }[]) {
  const seen = new Set<string>();
  return points.filter((point) => {
    const day = point.time.slice(0, 10);
    if (seen.has(day)) return false;
    seen.add(day);
    return true;
  });
}

function toChartDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) return value;
  if (!value) return new Date(Number.NaN);
  return new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
}

function inferCurrency(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.currency === "string" ? record.currency : null;
}

function buildWarnings(series: ChartSeries[]) {
  return series.filter((entry) => entry.stale || entry.points.length === 0).map((entry) => `${entry.label} has no stored observations in this range.`);
}
