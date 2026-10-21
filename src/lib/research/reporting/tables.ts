import type { ReportSection } from "./contracts";
import type { ReportArtifact } from "./report";

export function resolveTable(table: ReportSection["tables"][number], artifacts: ReportArtifact[]): unknown {
  const artifact = artifacts.find(a => a.id === table.artifact_id);
  if (!artifact) throw new Error(`Unknown table artifact ${table.artifact_id}`);
  let value: any = artifact.content_json;
  // Paths start inside content_json; writers sometimes name the field itself, which is the same place.
  const path = table.path?.replace(/^content_json(?:\.|$)/, "");
  for (const part of path ? path.split(".") : []) {
    if (["__proto__", "constructor", "prototype"].includes(part) || value == null || !Object.hasOwn(value, part)) {
      throw new Error(`Unknown table path ${table.path}`);
    }
    value = value[part];
  }
  return value;
}

/** Most rows a report table may print; a longer series belongs in Financials or a chart. */
export const MAX_TABLE_ROWS = 60;

export type TableCell = string | number | boolean | null;
export interface FlatTable { rows: Record<string, TableCell>[]; notes: string[] }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isCell = (value: unknown): value is TableCell => value === null || ["string", "number", "boolean"].includes(typeof value);

/** A computed valuation schedule (calculateValuationSchedule): yearly rows plus its totals. */
const isSchedule = (value: unknown): value is { years: unknown[] } & Record<string, unknown> =>
  isRecord(value) && Array.isArray(value.years) && typeof value.value_per_share === "number";

/** A list of plain values (claim IDs, mitigants) prints as one cell. */
const isCellList = (value: unknown): value is TableCell[] => Array.isArray(value) && value.every(isCell);
const cellOf = (value: unknown): TableCell | undefined =>
  value === undefined ? null : isCell(value) ? value : isCellList(value) ? value.map((item) => String(item)).join("; ") : undefined;

/**
 * A record with values one level deep at most, as flat columns ("build.capital_expenditures"); a list of plain
 * values is one joined cell. Anything deeper is rejected.
 */
function flatRow(row: Record<string, unknown>): Record<string, TableCell> | null {
  const flat: Record<string, TableCell> = {};
  for (const [key, value] of Object.entries(row)) {
    const direct = cellOf(value);
    if (direct !== undefined) { flat[key] = direct; continue; }
    if (!isRecord(value)) return null;
    for (const [sub, inner] of Object.entries(value)) {
      const nested = cellOf(inner);
      if (nested === undefined) return null;
      flat[`${key}.${sub}`] = nested;
    }
  }
  return flat;
}

/** A record keyed by fiscal year whose values are records (scenario statements by year). */
const isYearKeyed = (value: unknown): value is Record<string, Record<string, unknown>> =>
  isRecord(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, row]) => /^\d{4}$/.test(key) && isRecord(row));

/** A table value as flat rows, or null when it nests too deep. Columnar tables, schedules and year-keyed records are reshaped first. */
function rowsOf(value: unknown): FlatTable | null {
  const notes: string[] = [];
  const columnar = value as { columns?: unknown; rows?: unknown };
  if (isRecord(columnar) && Array.isArray(columnar.columns) && Array.isArray(columnar.rows) && columnar.rows.every(Array.isArray)) {
    const columns = columnar.columns as string[];
    value = (columnar.rows as unknown[][]).map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  } else if (isSchedule(value)) {
    const schedule = value;
    notes.push(["terminal_value", "terminal_present_value", "equity_value", "value_per_share"]
      .filter(key => typeof schedule[key] === "number").map(key => `${key}: ${schedule[key]}`).join("; "));
    value = schedule.years;
  } else if (isYearKeyed(value)) {
    value = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([year, row]) => ({ fiscal_year: Number(year), ...row }));
  }
  const rows = Array.isArray(value) ? value : [value];
  const flat = rows.map(row => isCell(row) || isCellList(row) ? { Value: cellOf(row)! } : isRecord(row) ? (isSchedule(row) ? null : flatRow(row)) : null);
  return flat.some(row => row === null) ? null : { rows: flat as Record<string, TableCell>[], notes: notes.filter(Boolean) };
}

/** A path that would render, at most MAX_TABLE_ROWS long. */
const renders = (value: unknown) => {
  const shaped = rowsOf(value);
  return Boolean(shaped && shaped.rows.length && shaped.rows.length <= MAX_TABLE_ROWS);
};
/** A multi-row table: a list of records or a year-keyed record. A lone record renders too but is a weaker suggestion. */
const isTableLike = (value: unknown) => (Array.isArray(value) && value.length > 0 && value.every(isRecord)) || isYearKeyed(value);

/**
 * The nearest path under a too-deep value that does render, so the suggestion always works when followed:
 * a schedule for a list of schedules or driver inputs (method_inputs -> method_schedules.N), a list of records or
 * year-keyed record under a record, or, for a list of rows, the first row's own table (scenarios.0.yearly_drivers).
 */
function renderableChild(value: unknown, content: unknown, path: string): string | null {
  const join = (...parts: string[]) => parts.filter(Boolean).join(".");
  const inputs = path.match(/(?:^|\.)method_inputs(?:\.(\d+))?$/);
  const schedules = isRecord(content) && Array.isArray(content.method_schedules) ? content.method_schedules : null;
  if (inputs && schedules) {
    const index = inputs[1] ?? "0";
    if (renders(schedules[Number(index)])) return `method_schedules.${index}`;
  }
  if (Array.isArray(value)) {
    const at = value.findIndex(isSchedule);
    if (at >= 0) return join(path, String(at));
    const first = value.find(isRecord);
    for (const [key, child] of Object.entries(first ?? {})) if (isTableLike(child) && renders(child)) return join(path, String(value.indexOf(first)), key);
    return null;
  }
  // Breadth first through records, never into a list's items: tables first, a list of schedules as its first
  // schedule, then a lone record.
  const queue: [string, unknown][] = [[path, value]];
  let single: string | null = null;
  while (queue.length) {
    const [at, node] = queue.shift()!;
    if (!isRecord(node)) continue;
    for (const [key, child] of Object.entries(node)) {
      if (isTableLike(child) && renders(child)) return join(at, key);
      if (Array.isArray(child) && isSchedule(child[0]) && renders(child[0])) return join(at, key, "0");
      if (!single && isRecord(child) && renders(child)) single = join(at, key);
    }
    for (const [key, child] of Object.entries(node)) if (isRecord(child)) queue.push([join(at, key), child]);
  }
  return single;
}

/**
 * The rows a report table prints, or an error the section writer can act on. A table is a { columns, rows } table,
 * a valuation schedule (its years, with the totals as a note), a record keyed by fiscal year, an array of records
 * whose values are at most one level deep, or a single such record. Anything deeper names the nearest path that
 * renders, and a table longer than MAX_TABLE_ROWS is rejected.
 */
export function flatTable(table: ReportSection["tables"][number], artifacts: ReportArtifact[]): FlatTable {
  const value = resolveTable(table, artifacts);
  const where = `Table "${table.title}" (${table.artifact_id} ${table.path || "root"})`;
  const shaped = rowsOf(value);
  const count = (shaped?.rows.length ?? (Array.isArray(value) ? value.length : 1));
  if (count > MAX_TABLE_ROWS) throw new Error(`${where} has ${count} rows; a report table holds at most ${MAX_TABLE_ROWS}. Request a summary table (financial_analytics) or a chart instead.`);
  if (!shaped) {
    const content = artifacts.find(a => a.id === table.artifact_id)?.content_json;
    const child = renderableChild(value, content, (table.path ?? "").replace(/^content_json(?:\.|$)/, ""));
    const suggestion = child ? ` Request ${child} instead.` : "";
    throw new Error(`${where} is not a list of flat rows: its values nest more than one level.${suggestion}`);
  }
  return shaped;
}
