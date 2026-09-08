import type { ChartSeriesConfig } from "./config";

export type ChartPoint = { time: string; value: number | null };

export type ChartSeries = {
  id: string;
  assetId: string;
  key: string;
  kind: ChartSeriesConfig["kind"];
  label: string;
  unit: string | null;
  currency: string | null;
  source: string | null;
  asOf: string | null;
  stale: boolean;
  points: ChartPoint[];
};

export type ChartDataResponse = {
  series: ChartSeries[];
  warnings: string[];
};

export type ChartTableRow = { time: string } & Record<string, string | number | null>;

/**
 * Aligns sparse series on the union of their timestamps. Missing observations
 * stay null so Recharts renders a gap instead of inventing a zero.
 */
export function alignChartSeries(series: ChartSeries[], normalization: "absolute" | "indexed" = "absolute"): ChartSeries[] {
  const times = [...new Set(series.flatMap((entry) => entry.points.map((point) => point.time)))].sort();
  return series.map((entry) => {
    const values = new Map(entry.points.map((point) => [point.time, point.value]));
    let base: number | null = null;
    if (normalization === "indexed") {
      for (const point of entry.points) {
        if (point.value != null && Number.isFinite(point.value) && point.value !== 0) {
          base = point.value;
          break;
        }
      }
    }
    const points = times.map((time) => {
      const value = values.get(time) ?? null;
      if (value == null || base == null || normalization === "absolute") return { time, value };
      return { time, value: (value / base) * 100 };
    });
    return { ...entry, points };
  });
}

export function chartTableRows(series: ChartSeries[]): ChartTableRow[] {
  const times = [...new Set(series.flatMap((entry) => entry.points.map((point) => point.time)))].sort();
  const bySeries = series.map((entry) => ({ entry, values: new Map(entry.points.map((point) => [point.time, point.value])) }));
  return times.map((time) => {
    const row: ChartTableRow = { time };
    for (const { entry, values } of bySeries) row[entry.id] = values.get(time) ?? null;
    return row;
  });
}

export function checkSeriesCompatibility(series: Array<Pick<ChartSeries, "unit" | "currency"> & Partial<Pick<ChartSeries, "points">>>, normalization: "absolute" | "indexed"):
  { compatible: boolean; reason?: string } {
  const populated = series.filter((entry) => !entry.points || entry.points.some((point) => point.value != null));
  if (normalization === "indexed" || populated.length < 2) return { compatible: true };
  const [first, ...rest] = populated;
  const unit = first.unit ?? null;
  const currency = first.currency ?? null;
  if (rest.some((entry) => (entry.unit ?? null) !== unit || (entry.currency ?? null) !== currency)) {
    return {
      compatible: false,
      reason: "Absolute overlays require matching units and currencies; use indexed normalization to compare different series.",
    };
  }
  return { compatible: true };
}

export function encodeChartDataForTable(series: ChartSeries[], normalization: "absolute" | "indexed") {
  return chartTableRows(alignChartSeries(series, normalization));
}
