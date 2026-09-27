// Request-only financial tables. The canonical artifact, report tables and hashes stay unchanged.
const seriesFields = ['metric_key', 'unit', 'currency', 'segment', 'geography', 'periodicity',
  'reporting_basis', 'metric_type', 'restatement_version', 'comparability_status', 'confidence'];
const sourceFields = ['source_document_id', 'available_at', 'filing_or_release_date', 'evidence_claim_id'];

function historyTable(rows: Record<string, any>[], path: string) {
  const columns = [...new Set(rows.flatMap(Object.keys))]
    .filter(key => key !== 'metadata_json' && !seriesFields.includes(key) && !sourceFields.includes(key));
  const series = new Map<string, { fields: Record<string, any>; rows: any[][] }>();
  const sourceIndex = new Map<string, number>();
  const sources: any[][] = [];
  rows.forEach((row, index) => {
    const fields = Object.fromEntries(seriesFields.map(key => [key, row[key] ?? null]));
    // Preserve accounting dimensions and labels; omit duplicated raw extraction/audit metadata.
    fields.dimensions = row.metadata_json?.dimensions ?? null;
    fields.statement_label = row.metadata_json?.statement_label ?? null;
    fields.metric_category = row.metadata_json?.metric_category ?? null;
    const key = JSON.stringify(fields);
    const group = series.get(key) || { fields, rows: [] };
    const source = sourceFields.map(key => row[key] ?? null);
    const sourceKey = JSON.stringify(source);
    if (!sourceIndex.has(sourceKey)) { sourceIndex.set(sourceKey, sources.length); sources.push(source); }
    group.rows.push([index, ...columns.map(key => row[key] ?? null), sourceIndex.get(sourceKey)]);
    series.set(key, group);
  });
  return { encoding: 'series_table', canonical_table_path: path,
    note: 'Every original observation is retained. Merge series.fields with row_columns and the indexed sources entry. observation_index is the original array index. For report tables use canonical_table_path; encoding fields are not canonical artifact paths. Raw extraction metadata remains in the stored artifact.',
    row_columns: ['observation_index', ...columns, 'source_index'], source_columns: sourceFields,
    sources, series: [...series.values()] };
}

export function researchPacketForModel(value: any): any {
  if (Array.isArray(value)) return value.map(researchPacketForModel);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if (value.artifact_type === 'historical_record' && Array.isArray(value.observations)) {
    return { ...value, observations: historyTable(value.observations, 'observations'),
      ...(Array.isArray(value.ttm_series) ? { ttm_series: historyTable(value.ttm_series, 'ttm_series') } : {}) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, researchPacketForModel(child)]));
}
