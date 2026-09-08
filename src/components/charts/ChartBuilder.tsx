"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import {
  CHART_MAX_ASSETS,
  CHART_MAX_SERIES,
  chartViewConfigSchema,
  createDefaultChartViewConfig,
  seriesId,
  type ChartSeriesConfig,
  type ChartViewConfig,
} from "@/lib/charts/config";
import { alignChartSeries, chartTableRows, type ChartDataResponse, type ChartSeries } from "@/lib/charts/data";
import { readChartViewConfigFromUrl, writeChartViewConfigToUrl } from "@/lib/charts/url-state";

export type ChartAssetOption = { id: string; name: string; symbol?: string | null };

export type ChartBuilderProps = {
  assetId: string;
  assetOptions?: ChartAssetOption[];
  initialConfig?: ChartViewConfig;
  className?: string;
  compact?: boolean;
};

type ViewRecord = { id: string; name: string; config: ChartViewConfig; updatedAt: string };

const SERIES_COLORS = ["#111827", "#4b5563", "#9ca3af", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0369a1"];

export function ChartBuilder({ assetId, assetOptions = [], initialConfig, className = "", compact = false }: ChartBuilderProps) {
  const fallback = useMemo(() => initialConfig ?? createDefaultChartViewConfig(assetId), [assetId, initialConfig]);
  const [config, setConfig] = useState<ChartViewConfig>(fallback);
  const [data, setData] = useState<ChartDataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [views, setViews] = useState<ViewRecord[]>([]);
  const [selectedView, setSelectedView] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<ChartSeriesConfig["kind"]>("metric");
  const [newKey, setNewKey] = useState("");
  const [newSeriesAssetId, setNewSeriesAssetId] = useState(assetId);

  useEffect(() => {
    const fromUrl = compact || typeof window === "undefined" ? null : readChartViewConfigFromUrl(window.location.href);
    const urlMatchesRun = !initialConfig?.runId || fromUrl?.runId === initialConfig.runId;
    if (fromUrl?.anchorAssetId === assetId && urlMatchesRun) {
      setConfig(fromUrl);
      return;
    }
    setConfig(initialConfig ?? createDefaultChartViewConfig(assetId));
    setSelectedView(null);
    setData(null);
  }, [assetId, compact, initialConfig]);

  useEffect(() => {
    if (compact || typeof window === "undefined") return;
    window.history.replaceState(window.history.state, "", writeChartViewConfigToUrl(config, window.location.href));
  }, [compact, config]);

  const runQuery = useCallback(async (nextConfig: ChartViewConfig, signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/charts/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig),
        signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? "Unable to load chart data");
      setData(body as ChartDataResponse);
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") {
        setData(null);
        setError(cause instanceof Error ? cause.message : "Unable to load chart data");
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void runQuery(config, controller.signal);
    return () => controller.abort();
  }, [config, runQuery]);

  const loadViews = useCallback(async () => {
    try {
      const response = await fetch(`/api/assets/${assetId}/chart-views`);
      if (!response.ok) return;
      const body = await response.json();
      setViews(Array.isArray(body) ? body : []);
    } catch {
      // Saved views are optional; the chart remains useful when storage is unavailable.
    }
  }, [assetId]);

  useEffect(() => {
    if (compact) return;
    void loadViews();
  }, [compact, loadViews]);

  function updateConfig(update: Partial<ChartViewConfig>) {
    setConfig((current) => ({ ...current, ...update }));
  }

  function addAsset(asset: ChartAssetOption) {
    if (config.assetIds.includes(asset.id) || config.assetIds.length >= CHART_MAX_ASSETS) return;
    updateConfig({ assetIds: [...config.assetIds, asset.id] });
  }

  function removeAsset(assetToRemove: string) {
    if (assetToRemove === config.anchorAssetId) return;
    const assetIds = config.assetIds.filter((id) => id !== assetToRemove);
    const series = config.series.filter((entry) => entry.assetId !== assetToRemove);
    updateConfig({
      assetIds,
      series: series.length > 0
        ? series
        : [{ kind: "price", assetId: config.anchorAssetId, key: "close", label: "Price" }],
    });
  }

  function addSeries() {
    if (config.series.length >= CHART_MAX_SERIES) return;
    const asset = config.assetIds.includes(newSeriesAssetId) ? newSeriesAssetId : config.assetIds[0] ?? assetId;
    const key = newKey.trim() || (newKind === "price" ? "close" : newKind === "scenario" ? "base" : "");
    if (!key) {
      setError(`Enter a ${newKind} key before adding the series.`);
      return;
    }
    const next: ChartSeriesConfig = { kind: newKind, assetId: asset, key };
    updateConfig({ series: [...config.series, next] });
    setError(null);
    setNewKey("");
  }

  function removeSeries(entry: ChartSeriesConfig) {
    if (config.series.length <= 1) return;
    const id = seriesId(entry);
    updateConfig({
      series: config.series.filter((candidate) => seriesId(candidate) !== id),
      hiddenSeries: config.hiddenSeries.filter((hidden) => hidden !== id),
    });
  }

  function toggleSeries(id: string) {
    const hidden = config.hiddenSeries.includes(id)
      ? config.hiddenSeries.filter((entry) => entry !== id)
      : [...config.hiddenSeries, id];
    updateConfig({ hiddenSeries: hidden });
  }

  async function saveView() {
    const parsed = chartViewConfigSchema.safeParse(config);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid chart configuration");
      return;
    }
    const method = selectedView ? "PATCH" : "POST";
    const url = selectedView ? `/api/assets/${assetId}/chart-views/${selectedView}` : `/api/assets/${assetId}/chart-views`;
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(method === "POST" ? config : { config }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body?.error ?? "Unable to save chart view");
      return;
    }
    setSelectedView(body.id);
    await loadViews();
  }

  async function deleteView() {
    if (!selectedView) return;
    const response = await fetch(`/api/assets/${assetId}/chart-views/${selectedView}`, { method: "DELETE" });
    if (!response.ok) return;
    setSelectedView(null);
    setConfig(fallback);
    await loadViews();
  }

  const chartSeries = useMemo(() => {
    if (!data) return [];
    return alignChartSeries(data.series, config.normalization).filter((entry) => !config.hiddenSeries.includes(entry.id));
  }, [config.hiddenSeries, config.normalization, data]);
  const rows = useMemo(() => chartTableRows(chartSeries), [chartSeries]);
  const assetName = (id: string) => assetOptions.find((asset) => asset.id === id)?.name ?? id.slice(0, 8);

  return (
    <section className={`space-y-4 ${className}`} aria-label="Chart builder">
      {!compact && <div className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 pb-3">
        <label className="min-w-52 flex-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Chart name
          <input
            value={config.name}
            onChange={(event) => updateConfig({ name: event.target.value })}
            className="mt-1 block w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm font-normal normal-case tracking-normal text-gray-900 outline-none focus:border-gray-500"
          />
        </label>
        <div className="flex items-center gap-2">
          <select
            aria-label="Saved chart views"
            value={selectedView ?? ""}
            onChange={(event) => {
              const view = views.find((candidate) => candidate.id === event.target.value);
              if (view) {
                setSelectedView(view.id);
                setConfig(view.config);
              }
            }}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs text-gray-700"
          >
            <option value="">Saved views</option>
            {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
          <button type="button" onClick={() => void saveView()} className="rounded-md bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-700">Save</button>
          {selectedView && <button type="button" onClick={() => void deleteView()} className="rounded-md border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50">Delete</button>}
        </div>
      </div>}

      {!compact && <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50/60 p-3 md:grid-cols-4">
        <label className="text-[11px] font-medium text-gray-500">
          Range
          <select value={config.range.preset} onChange={(event) => updateConfig({ range: { ...config.range, preset: event.target.value as ChartViewConfig["range"]["preset"] } })} className="mt-1 block w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
            <option value="1Y">1 year</option><option value="3Y">3 years</option><option value="5Y">5 years</option><option value="MAX">Max</option><option value="custom">Custom</option>
          </select>
        </label>
        <label className="text-[11px] font-medium text-gray-500">
          Display
          <select value={config.display} onChange={(event) => updateConfig({ display: event.target.value as ChartViewConfig["display"] })} className="mt-1 block w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
            <option value="line">Line</option><option value="area">Area</option><option value="bar">Bar</option>
          </select>
        </label>
        <label className="text-[11px] font-medium text-gray-500">
          Comparison
          <select value={config.normalization} onChange={(event) => updateConfig({ normalization: event.target.value as ChartViewConfig["normalization"] })} className="mt-1 block w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
            <option value="absolute">Absolute values</option><option value="indexed">Indexed to 100</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs text-gray-600"><input type="checkbox" checked={config.showTable} onChange={(event) => updateConfig({ showTable: event.target.checked })} /> Show data table</label>
      </div>}

      {!compact && config.range.preset === "custom" && (
        <div className="flex flex-wrap gap-3 text-xs text-gray-600">
          <label>Start <input type="date" value={config.range.start?.slice(0, 10) ?? ""} onChange={(event) => updateConfig({ range: { ...config.range, start: event.target.value } })} className="ml-1 rounded border border-gray-200 px-2 py-1" /></label>
          <label>End <input type="date" value={config.range.end?.slice(0, 10) ?? ""} onChange={(event) => updateConfig({ range: { ...config.range, end: event.target.value } })} className="ml-1 rounded border border-gray-200 px-2 py-1" /></label>
        </div>
      )}

      {!compact && <div className="flex flex-wrap items-end gap-2">
        <label className="text-[11px] font-medium text-gray-500">Asset
          <select aria-label="Series asset" value={newSeriesAssetId} onChange={(event) => setNewSeriesAssetId(event.target.value)} className="ml-2 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
            {config.assetIds.map((id) => <option key={id} value={id}>{assetName(id)}</option>)}
          </select>
        </label>
        <label className="text-[11px] font-medium text-gray-500">Add series
          <select value={newKind} onChange={(event) => setNewKind(event.target.value as ChartSeriesConfig["kind"])} className="ml-2 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
            <option value="price">Price</option><option value="metric">Metric</option><option value="valuation">Valuation</option><option value="scenario">Scenario</option>
          </select>
        </label>
        <input aria-label="Series key" placeholder={newKind === "price" ? "close" : "metric key"} value={newKey} onChange={(event) => setNewKey(event.target.value)} className="rounded border border-gray-200 px-2 py-1.5 text-xs" />
        <button type="button" onClick={addSeries} disabled={config.series.length >= CHART_MAX_SERIES} className="rounded border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-40">Add series</button>
        <span className="text-[11px] text-gray-400">{config.series.length}/{CHART_MAX_SERIES} series · {config.assetIds.length}/{CHART_MAX_ASSETS} assets</span>
      </div>}

      {!compact && assetOptions.length > 0 && <div className="flex flex-wrap gap-2">
        {config.assetIds.map((id) => <span key={id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">{assetName(id)}{id !== config.anchorAssetId && <button type="button" aria-label={`Remove ${assetName(id)}`} onClick={() => removeAsset(id)} className="text-gray-400 hover:text-gray-900">×</button>}</span>)}
        <select aria-label="Compare asset" value="" onChange={(event) => { const option = assetOptions.find((candidate) => candidate.id === event.target.value); if (option) addAsset(option); }} className="rounded-full border border-dashed border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-500">
          <option value="">+ Compare asset</option>{assetOptions.filter((asset) => !config.assetIds.includes(asset.id)).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select>
      </div>}

      {!compact && <div className="space-y-2">
        {config.series.map((entry, index) => {
          const id = seriesId(entry);
          return <div key={`${id}:${index}`} className="flex items-center gap-2 text-xs text-gray-600"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }} /><span className="min-w-0 flex-1 truncate">{entry.label ?? `${assetName(entry.assetId)} · ${entry.key}`}</span><button type="button" onClick={() => toggleSeries(id)} className="rounded border border-gray-200 px-2 py-0.5 text-[10px]">{config.hiddenSeries.includes(id) ? "Show" : "Hide"}</button><button type="button" onClick={() => removeSeries(entry)} disabled={config.series.length <= 1} className="text-gray-400 disabled:opacity-30" aria-label="Remove series">×</button></div>;
        })}
      </div>}
      {!compact && data?.series?.length ? <div className="grid gap-2 rounded-lg border border-gray-100 bg-gray-50/70 p-3 sm:grid-cols-2">
        {data.series.map((entry) => <div key={entry.id} className="min-w-0 text-[11px] text-gray-500"><div className="truncate font-semibold text-gray-700">{entry.label}</div><div className="truncate">{entry.source ?? "Stored data"}{entry.kind === "price" ? " · daily trading data" : ""}{entry.unit ? ` · ${entry.unit}` : ""}{entry.currency ? ` · ${entry.currency}` : ""}{entry.asOf ? ` · as of ${new Date(entry.asOf).toLocaleDateString()}` : " · no as-of date"}{entry.stale ? " · stale/empty" : ""}</div></div>)}
      </div> : null}

      <div className="rounded-lg border border-gray-200 bg-white p-2">
        {loading && <div className="flex items-center justify-center text-xs text-gray-400" style={{ height: "18rem" }} role="status">Loading stored observations…</div>}
        {!loading && error && <div className="flex flex-col items-center justify-center gap-2 text-center text-xs text-red-600" style={{ height: "18rem" }} role="alert"><p>{error}</p><button type="button" onClick={() => { const controller = new AbortController(); void runQuery(config, controller.signal); }} className="rounded border border-red-200 px-2 py-1 text-red-700">Retry</button></div>}
        {!loading && !error && chartSeries.length === 0 && <div className="flex items-center justify-center text-xs text-gray-400" style={{ height: "18rem" }}>No stored observations for this range.</div>}
        {!loading && !error && chartSeries.length > 0 && <ChartPlot series={chartSeries} display={config.display} summaryId={`chart-summary-${assetId}`} auditDetails={!compact} />}
      </div>
      {data?.warnings?.length ? <p className="text-[11px] text-amber-700">{data.warnings.join(" ")}</p> : null}
      {config.showTable && chartSeries.length > 0 && <ChartTable series={chartSeries} rows={rows} />}
    </section>
  );
}

function ChartPlot({ series, display, summaryId, auditDetails }: { series: ChartSeries[]; display: ChartViewConfig["display"]; summaryId: string; auditDetails: boolean }) {
  const rows = chartTableRows(series);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const summary = `${series.map((entry) => entry.label).join(", ")} across ${rows.length} observations.`;

  useEffect(() => {
    if (!canvasRef.current) return;
    const type = display === "bar" ? "bar" : "line";
    const chart = new Chart(canvasRef.current, {
      type,
      data: {
        labels: rows.map((row) => new Date(row.time).toLocaleDateString()),
        datasets: series.map((entry, index) => {
          const color = SERIES_COLORS[index % SERIES_COLORS.length];
          const pointCount = entry.points.filter((point) => point.value != null).length;
          const isDailyPrice = entry.kind === "price";
          const isSparseMetric = entry.kind === "metric" && pointCount <= 24;
          return {
            label: entry.label,
            data: rows.map((row) => typeof row[entry.id] === "number" ? Number(row[entry.id]) : null),
            borderColor: color,
            backgroundColor: display === "bar" ? `${color}b3` : `${color}1f`,
            borderWidth: 1.7,
            fill: display === "area",
            pointRadius: isDailyPrice ? 1.25 : isSparseMetric ? 2.5 : pointCount === 1 ? 3 : 0,
            pointHoverRadius: isDailyPrice ? 5 : isSparseMetric ? 5 : 4,
            pointHitRadius: isDailyPrice ? 8 : isSparseMetric ? 7 : 2,
            spanGaps: false,
            tension: 0.25,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, color: "#4b5563", font: { size: 10 } },
          },
          tooltip: {
            enabled: true,
            mode: "index",
            intersect: false,
            callbacks: {
              title: (items) => {
                const row = rows[items[0]?.dataIndex ?? -1];
                return row ? new Date(row.time).toLocaleDateString() : "";
              },
              label: (context) => {
                const entry = series[context.datasetIndex];
                const value = context.parsed.y;
                const suffix = [entry?.unit, entry?.currency !== entry?.unit ? entry?.currency : null].filter(Boolean).join(" ");
                const formatted = typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—";
                return `${entry?.label ?? context.dataset.label}: ${formatted}${suffix ? ` ${suffix}` : ""}`;
              },
              afterLabel: (context) => {
                if (!auditDetails) return "";
                const entry = series[context.datasetIndex];
                return [entry?.source, entry?.asOf ? `As of ${new Date(entry.asOf).toLocaleDateString()}` : null].filter(Boolean).join(" · ");
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 6, color: "#94a3b8", font: { size: 10 } }, border: { color: "#e2e8f0" } },
          y: { grid: { color: "#f1f5f9" }, ticks: { color: "#94a3b8", font: { size: 10 } }, border: { display: false } },
        },
      },
    } satisfies ChartConfiguration);

    return () => chart.destroy();
  }, [auditDetails, display, rows, series]);

  return <div style={{ height: "18rem" }}><span id={summaryId} className="sr-only">{summary}</span><canvas ref={canvasRef} role="img" aria-label="Chart of selected stored observations" aria-describedby={summaryId}>{summary}</canvas></div>;
}

function ChartTable({ series, rows }: { series: ChartSeries[]; rows: ReturnType<typeof chartTableRows> }) {
  return <div className="overflow-x-auto rounded-lg border border-gray-200"><table className="min-w-full divide-y divide-gray-200 text-left text-xs"><caption className="sr-only">Chart data table</caption><thead className="bg-gray-50"><tr><th scope="col" className="px-3 py-2 font-semibold text-gray-600">Date</th>{series.map((entry) => <th key={entry.id} scope="col" className="px-3 py-2 font-semibold text-gray-600">{entry.label}</th>)}</tr></thead><tbody className="divide-y divide-gray-100 bg-white">{rows.map((row) => <tr key={row.time}><th scope="row" className="whitespace-nowrap px-3 py-2 font-medium text-gray-700">{new Date(row.time).toLocaleDateString()}</th>{series.map((entry) => <td key={entry.id} className="px-3 py-2 text-gray-600">{typeof row[entry.id] === "number" ? Number(row[entry.id]).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}</td>)}</tr>)}</tbody></table></div>;
}
