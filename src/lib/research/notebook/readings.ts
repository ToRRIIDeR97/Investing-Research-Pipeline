/**
 * What the notebook shows for its references, computed from a run's stored artifacts. Pure and client-safe:
 * no database, network or model. Values are never stored with pins or KPIs; they are drawn from the latest run.
 */
import { buildExhibits, isAvailable, type BuiltExhibit } from "../reporting/exhibits";
import { kpiStatus, type KpiStatus } from "../reporting/kpi-health";
import { kpiSeries } from "../reporting/dashboard-series";
import { researchObservations } from "../reporting/data-views";
import { formatInUnit } from "../reporting/plain-english";
import { MetricBook, evaluateMetric, metricDef, observedPeriods, periodName, type Frequency, type MetricDef } from "../reporting/metric-catalogue";
import type { ReportDocument } from "../reporting/report";
import type { KpiSnapshotRow, NotebookAnnotation, NotebookKpi, NotebookPin } from "./contracts";

type Row = Record<string, any>;
/** Most periods a metric pin shows. */
export const PIN_PERIODS = 8;

/** A catalogue metric in the unit people read it in: percent for ratios, currency millions for money. */
function displayUnit(def: MetricDef, currency: string | null): { scale: number; unit: string } {
  const cur = currency ?? "USD";
  switch (def.kind) {
    case "pct": return { scale: 100, unit: "%" };
    case "money": case "per_person": return { scale: 1e-6, unit: `${cur} millions` };
    case "ps": return { scale: 1, unit: `${cur} per share` };
    case "x": return { scale: 1, unit: "x" };
    case "count": return { scale: 1, unit: "" };
  }
}
const shown = (value: number | null, unit: string) => value == null ? "—" : unit === "x" ? `${value.toFixed(1)}x` : formatInUnit(value, unit);

export type MetricSeries = { name: string; unit: string; points: { period: string; value: number | null; display: string }[]; formula: string };
/** The last PIN_PERIODS values of a catalogue metric, oldest first, in display units. */
export function metricSeries(key: string, observations: Row[], frequency: Frequency): MetricSeries | null {
  const def = metricDef(key);
  if (!def) return null;
  const book = new MetricBook(observations, frequency);
  const results = observedPeriods(observations, frequency).slice(-PIN_PERIODS).map((p) => evaluateMetric(book, def, p));
  const currency = results.find((r) => r.currency)?.currency ?? null;
  const { scale, unit } = displayUnit(def, currency);
  return { name: def.name, unit, formula: def.formula, points: results.map((r) => {
    const value = r.value == null ? null : r.value * scale;
    return { period: periodName(r.period), value, display: shown(value, unit) };
  }) };
}

export type PinView =
  | { pin: NotebookPin; kind: "exhibit"; title: string; exhibit: BuiltExhibit }
  | { pin: NotebookPin; kind: "metric"; title: string; series: MetricSeries }
  | { pin: NotebookPin; kind: "unavailable"; title: string; reason: string };

/** Each pin drawn from the run's artifacts, in pin order. A pin whose data the run lacks says why. */
export function pinViews(pins: NotebookPin[], artifacts: Row[]): PinView[] {
  const exhibits = buildExhibits(artifacts as any);
  const observations = researchObservations(artifacts);
  return [...pins].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)).map((pin): PinView => {
    if (pin.kind === "exhibit") {
      const exhibit = exhibits.find((e) => e.key === pin.ref_key);
      if (!exhibit) return { pin, kind: "unavailable", title: pin.ref_key, reason: "This exhibit is no longer in the report catalogue." };
      return isAvailable(exhibit) ? { pin, kind: "exhibit", title: exhibit.title, exhibit }
        : { pin, kind: "unavailable", title: exhibit.title, reason: exhibit.unavailable };
    }
    const series = metricSeries(pin.ref_key, observations, pin.frequency === "annual" ? "annual" : "quarterly");
    if (!series) return { pin, kind: "unavailable", title: pin.ref_key, reason: "This metric is no longer in the Financials catalogue." };
    if (!series.points.some((p) => p.value != null)) return { pin, kind: "unavailable", title: series.name, reason: "The latest run has no captured values for this metric." };
    return { pin, kind: "metric", title: series.name, series };
  });
}

export type KpiReading = { kpi: NotebookKpi; name: string; value: number | null; display: string; unit: string; period: string | null;
  status: KpiStatus | null; history: { period: string; display: string }[]; reason: string };

/** A personal KPI's latest reading and status against the operator's own lines. */
export function kpiReading(kpi: NotebookKpi, observations: Row[]): KpiReading {
  const base = { kpi, name: kpi.label };
  let points: { period: string; value: number | null }[] = [];
  let unit = "";
  if (kpi.metric_key.startsWith("metric:")) {
    const series = metricSeries(kpi.metric_key.slice(7), observations, "quarterly");
    if (!series) return { ...base, value: null, display: "—", unit, period: null, status: null, history: [], reason: "This metric is no longer in the Financials catalogue." };
    points = series.points; unit = series.unit;
  } else {
    const series = kpiSeries({ metric_key: kpi.metric_key, segment: kpi.segment ?? null }, observations, kpi.metric_key);
    // kpiSeries periods read "2026-Q2"; the notebook names quarters as the metric catalogue does ("Q2 2026").
    points = series.points.map((p) => ({ period: /^\d{4}-Q[1-4]$/.test(p.period) ? `${p.period.slice(5)} ${p.period.slice(0, 4)}` : p.period, value: p.value })); unit = series.unit;
    if (!points.length) return { ...base, value: null, display: "—", unit, period: null, status: null, history: [], reason: series.reason ?? "No readings were captured for this KPI." };
  }
  const last = [...points].reverse().find((p) => p.value != null) ?? null;
  const value = last?.value ?? null;
  const display = shown(value, unit);
  const status = kpiStatus(value, kpi.bear_line, kpi.bull_line);
  const line = kpi.bear_line == null ? null : shown(kpi.bear_line, unit);
  const reason = value == null ? "No reading has been captured for this KPI yet."
    : status === "danger" ? `${display} is past your danger line of ${line}.`
    : status === "caution" ? `${display} is within 5% of your danger line of ${line}.`
    : status === "healthy" ? `${display} is clear of your danger line of ${line}.`
    : "Set a danger line to track this KPI's health.";
  return { ...base, value, display, unit, period: last?.period ?? null, status,
    history: points.slice(-4).map((p) => ({ period: p.period, display: shown(p.value, unit) })), reason };
}

/** The readings a journal entry keeps, so a later visit can compare then and now. */
export function kpiSnapshot(kpis: NotebookKpi[], artifacts: Row[]): KpiSnapshotRow[] {
  const observations = researchObservations(artifacts);
  return kpis.slice(0, 50).map((kpi) => {
    const r = kpiReading(kpi, observations);
    return { kpi_id: kpi.id, label: kpi.label.slice(0, 120), value: r.value, display: r.display.slice(0, 60), unit: r.unit.slice(0, 60),
      period: r.period ? r.period.slice(0, 20) : null, status: r.status };
  });
}

export type AnnotationPlace = {
  annotation: NotebookAnnotation;
  /** attached: written on this report; carried: moved to the matching chapter of a newer report; unattached: no match. */
  state: "attached" | "carried" | "unattached";
  section_id: string | null; exhibit_key: string | null; paragraph_index: number | null; reason: string;
};

const exhibitsOf = (section: Row) => Array.isArray(section.exhibits) ? section.exhibits as string[] : [];

/**
 * Where a note belongs in a report. On the report it was written on, it stays on its chapter, exhibit or paragraph.
 * On another run's report it follows its exhibit to whichever chapter now shows it, else its chapter id, else the
 * body chapter sharing most of its coverage keys; a paragraph anchor drops to the chapter, since paragraphs move.
 * A note nothing matches is unattached, never dropped.
 */
export function placeAnnotation(annotation: NotebookAnnotation, document: Pick<ReportDocument, "sections">, runId: string | null): AnnotationPlace {
  const sections = document.sections as Row[];
  const byId = sections.find((s) => s.id === annotation.section_id);
  if (runId && annotation.research_run_id === runId && byId)
    return { annotation, state: "attached", section_id: byId.id, exhibit_key: annotation.exhibit_key, paragraph_index: annotation.paragraph_index, reason: "" };
  const carried = (section: Row, exhibit: string | null, reason: string): AnnotationPlace =>
    ({ annotation, state: "carried", section_id: String(section.id), exhibit_key: exhibit, paragraph_index: null, reason });
  if (annotation.exhibit_key) {
    const home = sections.find((s) => exhibitsOf(s).includes(annotation.exhibit_key!));
    if (home) return carried(home, annotation.exhibit_key, "Written on an earlier report; follows its exhibit.");
  }
  if (byId) return carried(byId, null, "Written on an earlier report; the same chapter.");
  const keys = new Set(annotation.section_coverage.filter((k) => k !== "conclusion"));
  let best: Row | null = null, bestScore = 0;
  for (const s of sections) {
    const coverage: string[] = Array.isArray(s.coverage) ? s.coverage : [];
    if (coverage.includes("conclusion") && !annotation.section_coverage.includes("conclusion")) continue;
    const score = coverage.filter((k) => keys.has(k)).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  if (best) return carried(best, null, "Written on an earlier report; the chapter covering the same areas.");
  return { annotation, state: "unattached", section_id: null, exhibit_key: annotation.exhibit_key, paragraph_index: null,
    reason: "No chapter of this report matches where the note was written." };
}

/** Every note placed in a report, plus the unattached ones. */
export function placeAnnotations(annotations: NotebookAnnotation[], document: Pick<ReportDocument, "sections">, runId: string | null) {
  const placed = annotations.map((a) => placeAnnotation(a, document, runId));
  return { bySection: (sectionId: string) => placed.filter((p) => p.section_id === sectionId), unattached: placed.filter((p) => p.state === "unattached") };
}

/**
 * The operator's KPIs as items `scoreDashboard` (monitor-check) scores on new filings: a catalogue metric names its
 * display scale, so a reading compares with lines stated in percent or currency millions.
 */
export function notebookMonitorItems(kpis: Pick<NotebookKpi, "label" | "metric_key" | "segment" | "bear_line" | "bull_line">[]): Row[] {
  return kpis.map((kpi) => {
    const catalogue = kpi.metric_key.startsWith("metric:") ? metricDef(kpi.metric_key.slice(7)) : undefined;
    return { kpi: kpi.label, metric_key: catalogue ? catalogue.key : kpi.metric_key, segment: kpi.segment ?? null,
      bear_threshold: kpi.bear_line, bull_threshold: kpi.bull_line, source: "notebook",
      ...(catalogue ? { display_scale: displayUnit(catalogue, null).scale } : {}) };
  });
}
