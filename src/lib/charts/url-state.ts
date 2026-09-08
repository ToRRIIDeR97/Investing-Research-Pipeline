import { chartViewConfigSchema, type ChartViewConfig } from "./config";

const QUERY_KEY = "chart";

export function encodeChartViewConfig(config: ChartViewConfig): string {
  return encodeURIComponent(JSON.stringify(config));
}
export function decodeChartViewConfig(value: string | null | undefined): ChartViewConfig | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    const result = chartViewConfigSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function readChartViewConfigFromUrl(url: string | URL): ChartViewConfig | null {
  const parsed = typeof url === "string" ? new URL(url, "http://localhost") : url;
  return decodeChartViewConfig(parsed.searchParams.get(QUERY_KEY));
}

export function writeChartViewConfigToUrl(config: ChartViewConfig, url: string | URL): string {
  const parsed = typeof url === "string" ? new URL(url, "http://localhost") : new URL(url.toString());
  parsed.searchParams.set(QUERY_KEY, encodeChartViewConfig(config));
  return typeof url === "string" && !url.startsWith("http")
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}
