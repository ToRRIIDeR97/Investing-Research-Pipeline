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
    note: 'Raw observations are omitted from this view: financial_analytics holds the computed history and financial_statement_summary the statement coverage. chart_series lists the quarterly series captured.',
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

/**
 * Most bytes a report-stage packet (outline, section, review, team requests) may carry before the rules, doctrine and
 * filing passages are added. Haiku 5.5 bills a prompt over 100K tokens at five times its rate, input and output; report
 * calls log about 0.49 tokens per packet byte (SoFi 0c9a2731), so 120 KB plus about 40 KB of rules and passages stays
 * near 80K tokens. On SoFi 0c9a2731, 94% of the run's cost came from calls over the threshold.
 */
export const REPORT_PACKET_BYTES = 120_000;
/** Valuation v2 judgments a capped view always keeps, whatever their size. */
export const KEPT_ARTIFACT_FIELDS = ['valuation_matrix', 'sanity', 'cross_checks', 'terminal_value_share', 'value_beyond_explicit_share'];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null));

/**
 * An artifact as a size-capped call reads it: the model view (historical_record becomes its coverage view), then its
 * top-level fields up to `fieldBytes` each, plus KEPT_ARTIFACT_FIELDS. Larger fields are named in omitted_fields; their
 * figures reach writers through report_facts and financial_analytics.
 */
export function cappedArtifactView<T extends { content_json: any }>(artifact: T, fieldBytes: number) {
  if (!artifact.content_json || typeof artifact.content_json !== 'object' || Array.isArray(artifact.content_json)) return artifact;
  const content = researchPacketForModel(artifact.content_json);
  const omitted = Object.keys(content).filter(key => !KEPT_ARTIFACT_FIELDS.includes(key) && bytes(content[key]) > fieldBytes);
  return { ...artifact, content_json: omitted.length ? Object.fromEntries(Object.entries(content).filter(([key]) => !omitted.includes(key))) : content,
    ...(omitted.length ? { omitted_fields: omitted } : {}) };
}

/**
 * Shrinks a report packet to `budget` bytes in fixed steps, stopping at the first that fits: artifacts capped at 8 KB
 * per field, then 2 KB; claims (under `evidenceKey`) without their quotes; then the claims cut by half from the end
 * down to 20; last, the largest artifacts dropped and named in omitted_artifacts. A packet that already fits is
 * returned unchanged, so small runs and the mock pipeline send what they always sent.
 */
export function fitPacket<P extends Record<string, any>>(packet: P, budget = REPORT_PACKET_BYTES, evidenceKey = 'evidence_claims'): P {
  let current: Record<string, any> = packet;
  const fits = () => bytes(current) <= budget;
  if (fits()) return packet;
  const artifacts = (map: (list: any[]) => any[]) => { if (Array.isArray(current.artifacts)) current = { ...current, artifacts: map(current.artifacts) }; };
  for (const fieldBytes of [8192, 2048]) {
    artifacts(list => list.map(a => a && typeof a === 'object' && 'content_json' in a ? cappedArtifactView(a, fieldBytes) : a));
    if (fits()) return current as P;
  }
  if (Array.isArray(current[evidenceKey])) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    current = { ...current, [evidenceKey]: current[evidenceKey].map(({ quote, ...claim }: Row) => claim) };
    while (!fits() && current[evidenceKey].length > 20)
      current = { ...current, [evidenceKey]: current[evidenceKey].slice(0, Math.max(20, Math.floor(current[evidenceKey].length / 2))) };
    if (fits()) return current as P;
  }
  // Keep catalogue order; drop the largest artifacts until the rest fits, naming them for the writer.
  if (Array.isArray(current.artifacts)) {
    const list: any[] = current.artifacts;
    const order = list.map((a, i) => ({ i, size: bytes(a) })).sort((a, b) => b.size - a.size);
    const dropped = new Set<number>();
    for (const { i } of order) {
      if (fits()) break;
      dropped.add(i);
      current = { ...current, artifacts: list.filter((_, k) => !dropped.has(k)),
        omitted_artifacts: list.filter((_, k) => dropped.has(k)).map(a => a?.artifact_type ?? a?.id) };
    }
  }
  return current as P;
}
