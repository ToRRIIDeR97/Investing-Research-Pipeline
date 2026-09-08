import { z } from "zod";

export const CHART_VIEW_CONFIG_VERSION = 1 as const;
export const CHART_MAX_ASSETS = 5;
export const CHART_MAX_SERIES = 8;
export const CHART_RANGE_PRESETS = ["1Y", "3Y", "5Y", "MAX", "custom"] as const;

const chartSeriesSchema = z.object({
  kind: z.enum(["price", "metric", "valuation", "scenario"]),
  assetId: z.string().min(1).max(128),
  key: z.string().min(1).max(128),
  runId: z.string().min(1).max(128).optional(),
  label: z.string().min(1).max(160).optional(),
  unit: z.string().max(64).optional(),
  currency: z.string().max(16).optional(),
});

const chartRangeSchema = z
  .object({
    preset: z.enum(CHART_RANGE_PRESETS),
    start: z.string().optional(),
    end: z.string().optional(),
  })
  .superRefine((range, ctx) => {
    if (range.preset !== "custom") return;
    if (!range.start || !range.end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Custom ranges require start and end dates" });
      return;
    }
    const start = Date.parse(range.start);
    const end = Date.parse(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Custom range dates must be valid ISO dates" });
    } else if (start > end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Custom range start must be before end" });
    }
  });

export const chartViewConfigSchema = z
  .object({
    version: z.literal(CHART_VIEW_CONFIG_VERSION),
    name: z.string().trim().min(1).max(80),
    anchorAssetId: z.string().min(1).max(128),
    assetIds: z.array(z.string().min(1).max(128)).min(1).max(CHART_MAX_ASSETS),
    runId: z.string().min(1).max(128).optional(),
    series: z.array(chartSeriesSchema).min(1).max(CHART_MAX_SERIES),
    range: chartRangeSchema,
    normalization: z.enum(["absolute", "indexed"]),
    display: z.enum(["line", "area", "bar"]),
    showTable: z.boolean().default(false),
    hiddenSeries: z.array(z.string().min(1).max(256)).max(CHART_MAX_SERIES).default([]),
  })
  .superRefine((config, ctx) => {
    if (new Set(config.assetIds).size !== config.assetIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assetIds"], message: "assetIds must be unique" });
    }
    if (!config.assetIds.includes(config.anchorAssetId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assetIds"],
        message: "assetIds must include anchorAssetId",
      });
    }
    const assetSet = new Set(config.assetIds);
    const seenSeries = new Set<string>();
    config.series.forEach((series, index) => {
      if (series.kind === "price" && !["open", "high", "low", "close", "adjusted_close"].includes(series.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["series", index, "key"],
          message: "Price series key must be open, high, low, close, or adjusted_close",
        });
      }
      if (!assetSet.has(series.assetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["series", index, "assetId"],
          message: "Series assetId must be present in assetIds",
        });
      }
      const id = seriesId(series);
      if (seenSeries.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["series", index],
          message: "Series must be unique",
        });
      }
      seenSeries.add(id);
    });
    const seriesIds = new Set(config.series.map(seriesId));
    config.hiddenSeries.forEach((id, index) => {
      if (!seriesIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hiddenSeries", index],
          message: "hiddenSeries contains an unknown series id",
        });
      }
    });
  });

export type ChartSeriesConfig = z.infer<typeof chartSeriesSchema>;
export type ChartRange = z.infer<typeof chartRangeSchema>;
export type ChartViewConfig = z.infer<typeof chartViewConfigSchema>;

export function seriesId(series: Pick<ChartSeriesConfig, "kind" | "assetId" | "key" | "runId">): string {
  return [series.kind, series.assetId, series.key, series.runId ?? "latest"].join(":");
}

export function createDefaultChartViewConfig(anchorAssetId: string): ChartViewConfig {
  return {
    version: CHART_VIEW_CONFIG_VERSION,
    name: "Untitled chart",
    anchorAssetId,
    assetIds: [anchorAssetId],
    series: [{ kind: "price", assetId: anchorAssetId, key: "close", label: "Price" }],
    range: { preset: "1Y" },
    normalization: "absolute",
    display: "line",
    showTable: false,
    hiddenSeries: [],
  };
}

export function parseChartViewConfig(input: unknown): ChartViewConfig {
  return chartViewConfigSchema.parse(input);
}

export function resolveChartRange(range: ChartRange, now = new Date()): { start: Date | null; end: Date } {
  const end = range.preset === "custom" && range.end ? new Date(range.end) : now;
  if (range.preset === "custom" && range.start) return { start: new Date(range.start), end };
  if (range.preset === "MAX") return { start: null, end };
  const years = range.preset === "1Y" ? 1 : range.preset === "3Y" ? 3 : 5;
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  return { start, end };
}

export function seriesDisplayId(series: ChartSeriesConfig, index = 0): string {
  return `${seriesId(series)}:${index}`;
}
