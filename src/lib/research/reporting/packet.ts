// Request-only view of the historical record. The canonical artifact, report tables and hashes stay unchanged.
type Row = Record<string, any>;
const MAX_LISTED = 10;

/**
 * Models read history through financial_analytics and financial_statement_summary; the raw observations
 * (455 KB on META) stay in the stored artifact for tables, charts and Financials. The view keeps coverage,
 * reconciliation and an index of the quarterly series a chart can name.
 */
function historyView(record: Row) {
  const observations: Row[] = record.observations;
  const series = new Map<string, { fields: unknown[]; periods: string[] }>();
  for (const o of observations) {
    if (o.periodicity !== 'quarterly' || o.value_numeric === null || o.value_numeric === undefined) continue;
    if (!/^[A-Z]{3}$/.test(o.unit ?? '') && o.unit !== 'shares') continue;
    const fields: unknown[] = [o.metric_key, o.segment ?? null, o.geography ?? null, o.unit ?? null, o.currency ?? null, o.reporting_basis ?? null];
    const key = JSON.stringify(fields);
    const entry = series.get(key) || { fields: [...fields, o.metadata_json?.statement_label ?? null], periods: [] as string[] };
    entry.periods.push(`${o.fiscal_year}Q${o.fiscal_quarter}`);
    series.set(key, entry);
  }
  const coverage = record.coverage ?? {};
  const issues: Row[] = record.reconciliation_issues ?? [];
  return {
    artifact_type: 'historical_record', asset_id: record.asset_id, run_id: record.run_id ?? null,
    note: 'Raw observations are omitted from this view: financial_analytics holds the computed history and financial_statement_summary the statement coverage. Charts may name any series in chart_series at path observations (periodicity quarterly).',
    coverage: { start: `${coverage.start_fiscal_year}Q${coverage.start_fiscal_quarter}`, end: `${coverage.end_fiscal_year}Q${coverage.end_fiscal_quarter}`,
      quarters_required: coverage.quarters_required, quarters_present: coverage.quarters_present, is_complete: coverage.is_complete,
      gaps: (coverage.gaps ?? []).length, first_gaps: (coverage.gaps ?? []).slice(0, MAX_LISTED).map((g: Row) => g.why_missing) },
    reconciliation_issues: { total: issues.length, blocking: issues.filter((i) => i.severity === 'blocking').length, first: issues.slice(0, MAX_LISTED) },
    observation_count: observations.length,
    chart_series: {
      columns: ['metric_key', 'segment', 'geography', 'unit', 'currency', 'reporting_basis', 'label', 'quarters', 'first', 'last'],
      rows: [...series.values()].filter((s) => s.periods.length >= 8).map((s) => {
        const sorted = [...new Set(s.periods)].sort();
        return [...s.fields, sorted.length, sorted[0], sorted.at(-1)];
      }),
    },
  };
}

export function researchPacketForModel(value: any): any {
  if (Array.isArray(value)) return value.map(researchPacketForModel);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if (value.artifact_type === 'historical_record' && Array.isArray(value.observations)) return historyView(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, researchPacketForModel(child)]));
}
