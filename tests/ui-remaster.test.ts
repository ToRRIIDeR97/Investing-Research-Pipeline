import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_REPORT_SECTIONS,
  RESEARCH_TABS,
  buildFinancialMetricMatrix,
  canonicalHeadingAnchor,
  canonicalHeadingNumber,
  safeMarkdownHref,
  tabForCanonicalHeading,
  tabPath,
} from "@/lib/research/report-ui";
import { generateMarkdownReport } from "@/lib/export/report-generator";
import {
  CHART_MAX_ASSETS,
  CHART_MAX_SERIES,
  createDefaultChartViewConfig,
  parseChartViewConfig,
  resolveChartRange,
  seriesId,
} from "@/lib/charts/config";
import {
  alignChartSeries,
  chartTableRows,
  checkSeriesCompatibility,
} from "@/lib/charts/data";
import {
  decodeChartViewConfig,
  readChartViewConfigFromUrl,
  writeChartViewConfigToUrl,
} from "@/lib/charts/url-state";

describe("UI remaster report contracts", () => {
  it("keeps the seven research tabs stable and ordered", () => {
    assert.deepEqual(
      RESEARCH_TABS.map((tab) => tab.slug),
      ["general", "financials", "valuation", "thesis", "evidence", "backtests", "updates"],
    );
    assert.equal(RESEARCH_TABS[0]?.label, "General");
    assert.equal(RESEARCH_TABS[1]?.label, "Financials & KPIs");
    assert.equal(RESEARCH_TABS[2]?.label, "Valuation");
  });

  it("maps every canonical report heading exactly once", () => {
    assert.equal(CANONICAL_REPORT_SECTIONS.length, 25);
    assert.deepEqual(
      CANONICAL_REPORT_SECTIONS.map(([number]) => number),
      Array.from({ length: 25 }, (_, index) => index + 1),
    );

    const expectedTabs = [
      "general", "general", "general", "evidence", "financials", "financials",
      "general", "general", "general", "general", "general", "financials",
      "financials", "financials", "financials", "valuation", "valuation", "valuation",
      "valuation", "thesis", "thesis", "updates", "backtests", "thesis", "updates",
    ];
    assert.deepEqual(
      CANONICAL_REPORT_SECTIONS.map(([number]) => tabForCanonicalHeading(number)),
      expectedTabs,
    );
  });

  it("parses heading labels and builds stable deep links with run context", () => {
    assert.equal(canonicalHeadingNumber("1. Executive conclusion"), 1);
    assert.equal(canonicalHeadingNumber("25) Limitations and open research"), 25);
    assert.equal(canonicalHeadingNumber("26. Unknown section"), null);
    assert.equal(canonicalHeadingNumber("Executive conclusion"), null);
    assert.equal(canonicalHeadingAnchor(16), "report-section-16");

    assert.equal(
      tabPath("asset/1", "valuation", "run 2"),
      "/assets/asset%2F1/research/valuation?run=run%202",
    );
    assert.equal(tabPath("asset-1", "general"), "/assets/asset-1/research/general");
  });

  it("allows workspace and HTTP(S) links but rejects executable schemes", () => {
    assert.equal(safeMarkdownHref("/assets/a/research/general"), "/assets/a/research/general");
    assert.equal(safeMarkdownHref("#valuation"), "#valuation");
    assert.equal(safeMarkdownHref("https://example.com/report"), "https://example.com/report");
    assert.equal(safeMarkdownHref("mailto:analyst@example.com"), null);
    assert.equal(safeMarkdownHref("javascript:alert(1)"), null);
    assert.equal(safeMarkdownHref("data:text/html,<script>alert(1)</script>"), null);
    assert.equal(safeMarkdownHref(""), null);
  });

  it("pivots financial observations into metric rows and reporting-period columns", () => {
    const matrix = buildFinancialMetricMatrix([
      { metric_key: "revenue", metric_display_name: "Revenue", period_end: "2025-03-31", value_numeric: "100", unit: "USD", currency: "USD" },
      { metric_key: "revenue", metric_display_name: "Revenue", period_end: "2025-06-30", value_numeric: "120", unit: "USD", currency: "USD" },
      { metric_key: "eps", metric_display_name: "EPS", as_of_date: "2025-06-30", value_numeric: "0.12", unit: "USD/share", currency: "USD" },
    ]);
    assert.deepEqual(matrix.periods, ["2025-06-30", "2025-03-31"]);
    assert.deepEqual(matrix.metrics.map((metric) => metric.key), ["revenue", "eps"]);
    assert.equal(matrix.metrics[0]?.values["2025-06-30"], "120");
    assert.equal(matrix.metrics[1]?.values["2025-03-31"], undefined);
  });

  it("preserves the canonical 25-heading Markdown export", () => {
    const report = generateMarkdownReport({
      runId: "ui-remaster-contract",
      asset: { canonical_name: "Test Asset", slug: "test-asset", asset_kind: "equity" },
    });
    let previousIndex = -1;
    for (const [number, title] of CANONICAL_REPORT_SECTIONS) {
      const heading = `## ${number}. ${title}`;
      const index = report.indexOf(heading);
      assert.ok(index >= 0, `missing canonical heading: ${heading}`);
      assert.ok(index > previousIndex, `canonical heading out of order: ${heading}`);
      previousIndex = index;
    }
  });

  it("validates the saved chart view limits and relationships", () => {
    const defaultView = createDefaultChartViewConfig("asset-1");
    assert.equal(defaultView.version, 1);
    assert.deepEqual(defaultView.assetIds, ["asset-1"]);
    assert.equal(defaultView.series.length, 1);

    const valid = parseChartViewConfig({
      ...defaultView,
      name: "Revenue comparison",
      assetIds: ["asset-1", "asset-2"],
      series: [
        { kind: "price", assetId: "asset-1", key: "close" },
        { kind: "metric", assetId: "asset-2", key: "revenue" },
      ],
      range: { preset: "custom", start: "2024-01-01", end: "2025-01-01" },
      normalization: "indexed",
    });
    assert.equal(valid.range.preset, "custom");

    assert.throws(() => parseChartViewConfig({
      ...defaultView,
      assetIds: Array.from({ length: CHART_MAX_ASSETS + 1 }, (_, index) => `asset-${index}`),
    }));
    assert.throws(() => parseChartViewConfig({
      ...defaultView,
      series: Array.from({ length: CHART_MAX_SERIES + 1 }, (_, index) => ({
        kind: "price",
        assetId: "asset-1",
        key: `metric-${index}`,
      })),
    }));
    assert.throws(() => parseChartViewConfig({
      ...defaultView,
      assetIds: ["asset-2"],
    }));
    assert.throws(() => parseChartViewConfig({
      ...defaultView,
      range: { preset: "custom", start: "2025-01-01", end: "2024-01-01" },
    }));
    assert.throws(() => parseChartViewConfig({
      ...defaultView,
      series: [{ kind: "price", assetId: "not-selected", key: "close" }],
    }));
  });

  it("aligns sparse chart series without inventing zero observations", () => {
    const series = [
      {
        id: "price:a:close:latest",
        assetId: "a",
        key: "close",
        kind: "price" as const,
        label: "A",
        unit: "price",
        currency: "USD",
        source: "stored",
        asOf: "2025-01-02",
        stale: false,
        points: [
          { time: "2025-01-01", value: 100 },
          { time: "2025-01-03", value: 120 },
        ],
      },
      {
        id: "price:b:close:latest",
        assetId: "b",
        key: "close",
        kind: "price" as const,
        label: "B",
        unit: "price",
        currency: "USD",
        source: "stored",
        asOf: "2025-01-03",
        stale: false,
        points: [{ time: "2025-01-02", value: 50 }],
      },
    ];
    const aligned = alignChartSeries(series);
    assert.deepEqual(aligned[0]?.points, [
      { time: "2025-01-01", value: 100 },
      { time: "2025-01-02", value: null },
      { time: "2025-01-03", value: 120 },
    ]);
    assert.deepEqual(aligned[1]?.points, [
      { time: "2025-01-01", value: null },
      { time: "2025-01-02", value: 50 },
      { time: "2025-01-03", value: null },
    ]);

    const indexed = alignChartSeries(series, "indexed");
    assert.equal(indexed[0]?.points[0]?.value, 100);
    assert.equal(indexed[0]?.points[2]?.value, 120);
    assert.equal(indexed[1]?.points[1]?.value, 100);
    assert.equal(indexed[0]?.points[1]?.value, null);

    const rows = chartTableRows(aligned);
    assert.equal(rows.length, 3);
    assert.equal(rows[1]?.[series[0].id], null);
  });

  it("requires compatible units for absolute overlays and allows indexed comparisons", () => {
    assert.deepEqual(checkSeriesCompatibility([
      { unit: "USD", currency: "USD" },
      { unit: "USD", currency: "USD" },
    ], "absolute"), { compatible: true });
    assert.equal(checkSeriesCompatibility([
      { unit: "USD", currency: "USD" },
      { unit: "EUR", currency: "EUR" },
    ], "absolute").compatible, false);
    assert.equal(checkSeriesCompatibility([
      { unit: "USD", currency: "USD" },
      { unit: "EUR", currency: "EUR" },
    ], "indexed").compatible, true);
    assert.equal(checkSeriesCompatibility([
      { unit: "USD", currency: "USD", points: [{ time: "2025-01-01", value: 1 }] },
      { unit: null, currency: null, points: [] },
    ], "absolute").compatible, true);
  });

  it("round-trips chart state in the URL and rejects malformed state", () => {
    const config = createDefaultChartViewConfig("asset-1");
    const path = writeChartViewConfigToUrl(config, "/assets/asset-1/research/general?run=run-1");
    assert.match(path, /^\/assets\/asset-1\/research\/general\?run=run-1&chart=/);
    assert.deepEqual(readChartViewConfigFromUrl(path), config);
    assert.deepEqual(decodeChartViewConfig("not-json"), null);
  });

  it("resolves chart range presets against a stable clock", () => {
    const now = new Date("2025-06-15T00:00:00.000Z");
    const oneYear = resolveChartRange({ preset: "1Y" }, now);
    assert.equal(oneYear.end.toISOString(), now.toISOString());
    assert.equal(oneYear.start?.toISOString(), "2024-06-15T00:00:00.000Z");
    assert.equal(resolveChartRange({ preset: "MAX" }, now).start, null);
    assert.equal(
      resolveChartRange({ preset: "custom", start: "2024-01-01", end: "2024-12-31" }, now).start?.toISOString(),
      "2024-01-01T00:00:00.000Z",
    );
    assert.equal(seriesId({ kind: "price", assetId: "asset-1", key: "close" }), "price:asset-1:close:latest");
  });
});
